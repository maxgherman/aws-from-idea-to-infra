import { CopyObjectCommand, S3Client } from '@aws-sdk/client-s3';

const s3 = new S3Client({});

export const handler = async (event: any) => {
  const bucket = requiredEnv('ASSET_BUCKET_NAME');
  await s3.send(new CopyObjectCommand({
    Bucket: bucket,
    CopySource: `${bucket}/${encodeURIComponent(event.sourceKey)}`,
    Key: event.outputKey,
    ContentType: event.contentType,
    MetadataDirective: 'REPLACE',
  }));
  return event;
};

const requiredEnv = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
};
