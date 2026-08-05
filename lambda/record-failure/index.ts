import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const handler = async (event: any) => {
  console.error('Asset workflow failed', {
    assetId: event.assetId,
    failure: event.failure,
  });
  await db.send(new UpdateCommand({
    TableName: requiredEnv('ASSETS_TABLE_NAME'),
    Key: { assetId: event.assetId },
    UpdateExpression: 'SET #status = :status, #error = :error, updatedAt = :now',
    ExpressionAttributeNames: { '#status': 'status', '#error': 'error' },
    ExpressionAttributeValues: {
      ':status': 'failed',
      ':error': 'Processing failed; inspect the Step Functions execution history',
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
