import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

export const handler = async (event: any) => {
  const batchItemFailures = [];

  for (const message of event.Records ?? []) {
    try {
      const s3Event = JSON.parse(message.body);
      for (const record of s3Event.Records ?? []) await processObject(record);
    } catch (error) {
      console.error('Asset processing failed', { messageId: message.messageId, error });
      batchItemFailures.push({ itemIdentifier: message.messageId });
    }
  }

  return { batchItemFailures };
};

async function processObject(record: any) {
  const sourceKey = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
  const match = sourceKey.match(/^uploads\/originals\/([0-9a-f-]+)\.(png|jpg)$/);
  const assetId = match?.[1];
  if (!assetId) throw new Error(`Unexpected object key: ${sourceKey}`);

  const { Item: asset } = await db.send(new GetCommand({
    TableName: requiredEnv('ASSETS_TABLE_NAME'),
    Key: { assetId },
    ConsistentRead: true,
  }));
  if (!asset || asset.sourceKey !== sourceKey) throw new Error('Upload has no matching asset record');
  if (asset.status === 'ready' || asset.status === 'rejected') return;

  await update(assetId, 'SET #status = :status, updatedAt = :now', {
    ':status': 'processing',
    ':now': new Date().toISOString(),
  });

  const sample = await s3.send(new GetObjectCommand({
    Bucket: requiredEnv('ASSET_BUCKET_NAME'),
    Key: sourceKey,
    Range: 'bytes=0-15',
  }));
  const bytes = new Uint8Array(await sample.Body!.transformToByteArray());
  if (!hasExpectedSignature(bytes, asset.contentType)) {
    await s3.send(new DeleteObjectCommand({
      Bucket: requiredEnv('ASSET_BUCKET_NAME'),
      Key: sourceKey,
    }));
    await update(assetId, 'SET #status = :status, #error = :error, updatedAt = :now', {
      ':status': 'rejected',
      ':error': 'File bytes do not match the requested image type',
      ':now': new Date().toISOString(),
    });
    return;
  }

  const extension = asset.contentType === 'image/png' ? 'png' : 'jpg';
  const outputKey = `processed/assets/${assetId}.${extension}`;
  await s3.send(new CopyObjectCommand({
    Bucket: requiredEnv('ASSET_BUCKET_NAME'),
    CopySource: `${requiredEnv('ASSET_BUCKET_NAME')}/${encodeURIComponent(sourceKey)}`,
    Key: outputKey,
    ContentType: asset.contentType,
    MetadataDirective: 'REPLACE',
  }));
  await update(assetId, 'SET #status = :status, outputKey = :outputKey, updatedAt = :now REMOVE expiresAt', {
    ':status': 'ready',
    ':outputKey': outputKey,
    ':now': new Date().toISOString(),
  });
}

function hasExpectedSignature(bytes: Uint8Array, contentType: string) {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const jpeg = [0xff, 0xd8, 0xff];
  const expected = contentType === 'image/png' ? png : jpeg;
  return expected.every((byte, index) => bytes[index] === byte);
}

function update(assetId: string, expression: string, values: Record<string, unknown>) {
  const names: Record<string, string> = { '#status': 'status' };
  if (expression.includes('#error')) names['#error'] = 'error';
  return db.send(new UpdateCommand({
    TableName: requiredEnv('ASSETS_TABLE_NAME'),
    Key: { assetId },
    UpdateExpression: expression,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    ConditionExpression: 'attribute_exists(assetId)',
  }));
}

const requiredEnv = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
};
