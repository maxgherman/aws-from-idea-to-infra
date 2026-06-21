import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const acceptedTypes = new Map<string, string>([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
]);
const maxBytes = 10 * 1024 * 1024;

export const handler = async (event: any) => {
  const ownerId = event?.requestContext?.authorizer?.jwt?.claims?.sub;
  if (!ownerId) return reply(401, { error: 'Authentication is required' });

  let request: { contentType?: string };
  try {
    request = JSON.parse(event.body ?? '{}');
  } catch {
    return reply(400, { error: 'Invalid JSON body' });
  }

  const contentType = request.contentType ?? '';
  const extension = acceptedTypes.get(contentType);
  if (!extension) {
    return reply(400, { error: 'Only image/png and image/jpeg are accepted' });
  }

  const assetId = randomUUID();
  const sourceKey = `uploads/originals/${assetId}.${extension}`;
  const now = new Date();
  const expiresAt = Math.floor(now.getTime() / 1_000) + 24 * 60 * 60;

  await db.send(new PutCommand({
    TableName: requiredEnv('ASSETS_TABLE_NAME'),
    Item: {
      assetId,
      ownerId,
      status: 'uploading',
      contentType,
      sourceKey,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt,
    },
    ConditionExpression: 'attribute_not_exists(assetId)',
  }));

  const upload = await createPresignedPost(s3, {
    Bucket: requiredEnv('ASSET_BUCKET_NAME'),
    Key: sourceKey,
    Expires: 300,
    Fields: { 'Content-Type': contentType },
    Conditions: [
      ['content-length-range', 1, maxBytes],
      ['eq', '$Content-Type', contentType],
      ['eq', '$key', sourceKey],
    ],
  });

  return reply(201, { asset: { assetId, status: 'uploading' }, upload });
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
