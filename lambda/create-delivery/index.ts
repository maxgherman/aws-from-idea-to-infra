import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const ttlSeconds = 5 * 60;

export const handler = async (event: any) => {
  const assetId = event?.pathParameters?.assetId;
  const ownerId = event?.requestContext?.authorizer?.jwt?.claims?.sub;

  if (!ownerId) return reply(401, { error: 'Authentication is required' });
  if (!assetId) return reply(400, { error: 'assetId is required' });

  const { Item: asset } = await db.send(new GetCommand({
    TableName: requiredEnv('ASSETS_TABLE_NAME'),
    Key: { assetId },
    ConsistentRead: true,
    ProjectionExpression: 'assetId, ownerId, #status, outputKey',
    ExpressionAttributeNames: { '#status': 'status' },
  }));

  const decision = decideDelivery(asset, ownerId, assetId);
  if (decision.status === 'not-found') {
    return reply(404, { error: 'Asset not found' });
  }
  if (decision.status === 'not-ready') {
    return reply(409, { error: 'Asset is not ready' });
  }

  const expiresAt = new Date(Date.now() + ttlSeconds * 1_000);
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: requiredEnv('ASSET_BUCKET_NAME'),
      Key: decision.outputKey,
    }),
    { expiresIn: ttlSeconds },
  );

  return reply(200, {
    delivery: {
      url,
      expiresAt: expiresAt.toISOString(),
    },
  });
};

export const decideDelivery = (asset: any, ownerId: string, assetId: string) => {
  if (!asset || asset.ownerId !== ownerId) {
    return { status: 'not-found' } as const;
  }
  if (asset.status !== 'ready' || !asset.outputKey) {
    return { status: 'not-ready' } as const;
  }

  const expectedPrefix = `processed/assets/${assetId}.`;
  if (typeof asset.outputKey !== 'string' || !asset.outputKey.startsWith(expectedPrefix)) {
    throw new Error(`Unexpected output key for asset ${assetId}`);
  }

  return { status: 'ready', outputKey: asset.outputKey } as const;
};

const reply = (statusCode: number, body: unknown) => ({
  statusCode,
  headers: {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  },
  body: JSON.stringify(body),
});

const requiredEnv = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
};
