'use strict';
const fs = require('fs');
const path = require('path');

// S3-compatible storage service
// Falls back to local disk if S3_BUCKET is not configured

let s3Client = null;
let S3Enabled = false;

function initStorage() {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) return; // local disk mode

  try {
    const { S3Client } = require('@aws-sdk/client-s3');
    s3Client = new S3Client({
      region: process.env.S3_REGION || 'us-east-1',
      endpoint: process.env.S3_ENDPOINT, // for Railway/Backblaze/MinIO
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      },
      forcePathStyle: !!process.env.S3_ENDPOINT, // required for non-AWS S3
    });
    S3Enabled = true;
  } catch (e) {
    console.warn('S3 SDK not available, falling back to local disk:', e.message);
  }
}

initStorage();

/**
 * Upload a file buffer or stream to storage.
 * @param {string} key - Storage key (e.g. "outputs/doc-uuid.pdf")
 * @param {Buffer} buffer - File content
 * @param {string} contentType - MIME type
 * @returns {Promise<{key: string, url: string|null}>}
 */
async function uploadFile(key, buffer, contentType = 'application/octet-stream') {
  if (!S3Enabled) {
    // Local disk fallback
    const localPath = path.join(__dirname, '../../', key);
    await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
    await fs.promises.writeFile(localPath, buffer);
    return { key, url: null }; // URL served by local route
  }

  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  await s3Client.send(new PutObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }));
  return { key, url: null }; // presigned URL generated on demand
}

/**
 * Generate a presigned download URL (S3) or return null for local serving.
 * @param {string} key
 * @param {number} expiresInSeconds
 * @returns {Promise<string|null>} - Download URL or null (caller falls back to local file serving)
 */
async function getDownloadUrl(key, expiresInSeconds = 3600) {
  if (!S3Enabled) {
    // Local disk: return null so caller falls back to local file serving
    return null;
  }

  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

  const url = await getSignedUrl(
    s3Client,
    new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }),
    { expiresIn: expiresInSeconds }
  );
  return url;
}

/**
 * Delete a file from storage.
 * @param {string} key
 */
async function deleteFile(key) {
  if (!S3Enabled) {
    const localPath = path.join(__dirname, '../../', key);
    await fs.promises.unlink(localPath).catch(() => {}); // ignore if not found
    return;
  }

  const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
  await s3Client.send(new DeleteObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: key,
  }));
}

/**
 * Check if a file exists in storage.
 * @param {string} key
 * @returns {Promise<boolean>}
 */
async function fileExists(key) {
  if (!S3Enabled) {
    const localPath = path.join(__dirname, '../../', key);
    return fs.existsSync(localPath);
  }

  const { HeadObjectCommand } = require('@aws-sdk/client-s3');
  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
    return true;
  } catch (e) {
    if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return false;
    throw e;
  }
}

module.exports = {
  uploadFile,
  getDownloadUrl,
  deleteFile,
  fileExists,
  get isS3Enabled() { return S3Enabled; },
};
