import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

export const handler = async (event: any) => {
  await s3.send(new DeleteObjectCommand({
    Bucket: requiredEnv('ASSET_BUCKET_NAME'),
    Key: event.sourceKey,
  }));
  await db.send(new UpdateCommand({
    TableName: requiredEnv('ASSETS_TABLE_NAME'),
    Key: { assetId: event.assetId },
    UpdateExpression: 'SET #status = :status, #error = :error, updatedAt = :now',
    ExpressionAttributeNames: { '#status': 'status', '#error': 'error' },
    ExpressionAttributeValues: {
      ':status': 'rejected',
      ':error': event.reason,
      ':now': new Date().toISOString(),
    },
    ConditionExpression: 'attribute_exists(assetId)',
  }));
  return event;
};

const requiredEnv = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
};
