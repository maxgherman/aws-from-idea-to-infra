import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const handler = async (event: any) => {
  await db.send(new UpdateCommand({
    TableName: requiredEnv('ASSETS_TABLE_NAME'),
    Key: { assetId: event.assetId },
    UpdateExpression: 'SET #status = :status, outputKey = :outputKey, updatedAt = :now REMOVE expiresAt, #error',
    ExpressionAttributeNames: { '#status': 'status', '#error': 'error' },
    ExpressionAttributeValues: {
      ':status': 'ready',
      ':outputKey': event.outputKey,
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
