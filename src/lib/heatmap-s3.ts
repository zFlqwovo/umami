import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

let client: S3Client | null = null;

function getBucket() {
  const bucket = process.env.S3_HEATMAP_BUCKET;

  if (!bucket) {
    throw new Error('S3_HEATMAP_BUCKET is not set.');
  }

  return bucket;
}

function getClient() {
  if (!client) {
    client = new S3Client({
      region: process.env.AWS_REGION,
    });
  }

  return client;
}

export async function putHeatmapSnapshot(
  objectKey: string,
  imageData: Buffer,
  mimeType: string,
) {
  await getClient().send(
    new PutObjectCommand({
      Bucket: getBucket(),
      Key: objectKey,
      Body: imageData,
      ContentType: mimeType,
    }),
  );
}

export async function getHeatmapSnapshot(objectKey: string) {
  const response = await getClient().send(
    new GetObjectCommand({
      Bucket: getBucket(),
      Key: objectKey,
    }),
  );

  if (!response.Body) {
    return null;
  }

  return {
    mimeType: response.ContentType || 'application/octet-stream',
    imageData: Buffer.from(await response.Body.transformToByteArray()),
  };
}
