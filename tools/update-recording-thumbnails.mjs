/**
 * This tool is only useful once recordings of breakout sessions have been
 * uploaded to Cloudflare. It updates the thumbnails of the recordings on
 * Cloudflare to use a screenshot at 1% of the video, the goal being to avoid
 * that the initial black screen gets used as thumbnail.
 *
 * To run the tool:
 *
 *  node tools/update-recording-thumbnails.mjs
 *
 * Pre-requisites:
 * 1. Recordings must have been uploaded to Cloudflare with a name that starts
 * with a well-known prefix.
 * 2. The well-known prefix must appear in a RECORDING_PREFIX env variable.
 * 3. Cloudflare account info must appear in CLOUDFLARE_ACCOUNT and
 * CLOUDFLARE_TOKEN env variables.
 */

import path from 'path';
import fs from 'fs/promises';
import { getEnvKey } from './lib/envkeys.mjs';

async function listRecordings(accountId, authToken, recordingPrefix) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream?search=${recordingPrefix}`,
    {
      headers: {
        'Authorization': `Bearer ${authToken}`
      }
    }
  );
  const json = await response.json();
  const recordings = json.result
    .filter(v => v.meta.name.startsWith(recordingPrefix))
    .map(v => Object.assign({
      sessionId: v.meta.name.match(/-(\d+)\.mp4$/)[1],
      name: v.meta.name,
      videoId: v.uid
    }))
    .sort((v1, v2) => v1.name.localeCompare(v2.name));
  return recordings;
}

async function updateThumbnail(recording, accountId, authToken) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/${recording.videoId}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({
        uid: recording.videoId,
        // Consider that a screenshot taken after 1% of the meeting
        // will be a good thumbnail
        thumbnailTimestampPct: 0.01
      }, null, 2)
    }
  );
  const json = await response.json();
  if (!json.success) {
    console.warn(`Thumbnail could not be set for session #${recording.sessionId} - ${recording.videoId}`);
  }
}

async function main() {
  const CLOUDFLARE_ACCOUNT = await getEnvKey('CLOUDFLARE_ACCOUNT');
  const CLOUDFLARE_TOKEN = await getEnvKey('CLOUDFLARE_TOKEN');
  const RECORDING_PREFIX = await getEnvKey('RECORDING_PREFIX');
  const recordings = await listRecordings(CLOUDFLARE_ACCOUNT, CLOUDFLARE_TOKEN, RECORDING_PREFIX);
  for (const recording of recordings) {
    await updateThumbnail(recording, CLOUDFLARE_ACCOUNT, CLOUDFLARE_TOKEN);
  }
}

main().then(_ => process.exit(0));

