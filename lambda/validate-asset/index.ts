import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

type WorkflowInput = {
  assetId: string;
  sourceKey: string;
};

export const handler = async (event: WorkflowInput) => {
  const { assetId, sourceKey } = validateWorkflowInput(event);
  const { Item: asset } = await db.send(new GetCommand({
    TableName: requiredEnv('ASSETS_TABLE_NAME'),
    Key: { assetId },
    ConsistentRead: true,
  }));
  if (!asset || asset.sourceKey !== sourceKey) {
    throw new Error('Upload has no matching asset record');
  }

  await db.send(new UpdateCommand({
    TableName: requiredEnv('ASSETS_TABLE_NAME'),
    Key: { assetId },
    UpdateExpression: 'SET #status = :status, updatedAt = :now',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':status': 'processing',
      ':now': new Date().toISOString(),
    },
    ConditionExpression: 'attribute_exists(assetId)',
  }));

  const sample = await s3.send(new GetObjectCommand({
    Bucket: requiredEnv('ASSET_BUCKET_NAME'),
    Key: sourceKey,
    Range: 'bytes=0-15',
  }));
  const bytes = new Uint8Array(await sample.Body!.transformToByteArray());
  const valid = hasExpectedSignature(bytes, asset.contentType);
  const extension = asset.contentType === 'image/png' ? 'png' : 'jpg';

  return {
    assetId,
    sourceKey,
    contentType: asset.contentType,
    outputKey: `processed/assets/${assetId}.${extension}`,
    valid,
    ...(valid ? {} : { reason: 'File bytes do not match the requested image type' }),
  };
};

export const validateWorkflowInput = (event: WorkflowInput) => {
  const match = event?.sourceKey?.match(/^uploads\/originals\/([0-9a-f-]+)\.(png|jpg)$/);
  if (!event?.assetId || match?.[1] !== event.assetId) {
    throw new Error('Workflow input does not identify one uploaded asset');
  }
  return event;
};

export const hasExpectedSignature = (bytes: Uint8Array, contentType: string) => {
  const signatures: Record<string, number[]> = {
    'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    'image/jpeg': [0xff, 0xd8, 0xff],
  };
  const expected = signatures[contentType];
  return Boolean(expected?.every((byte, index) => bytes[index] === byte));
};

const requiredEnv = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
};
