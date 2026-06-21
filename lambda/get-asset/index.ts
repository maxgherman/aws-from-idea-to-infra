import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const handler = async (event: any) => {
  const assetId = event?.pathParameters?.assetId;
  const ownerId = event?.requestContext?.authorizer?.jwt?.claims?.sub;
  if (!assetId || !ownerId) return reply(400, { error: 'assetId is required' });

  const { Item: asset } = await db.send(new GetCommand({
    TableName: requiredEnv('ASSETS_TABLE_NAME'),
    Key: { assetId },
    ConsistentRead: true,
  }));
  if (!asset || asset.ownerId !== ownerId) return reply(404, { error: 'Asset not found' });

  const result: Record<string, unknown> = {
    assetId: asset.assetId,
    status: asset.status,
    contentType: asset.contentType,
    createdAt: asset.createdAt,
  };
  if (asset.status === 'ready') {
    const extension = asset.contentType === 'image/png' ? 'png' : 'jpg';
    result.url = `${requiredEnv('ASSET_BASE_URL')}/${asset.assetId}.${extension}`;
  }
  if (asset.status === 'rejected') result.error = asset.error;

  return reply(200, { asset: result });
};

const reply = (statusCode: number, body: unknown) => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const requiredEnv = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
};
