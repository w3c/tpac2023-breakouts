/**
 * This tool is only useful once recordings of breakout sessions have been
 * uploaded to Cloudflare with captions. It allows to clip a recording between
 * the given start time and end time (in seconds).
 * 
 * To run the tool:
 *
 *  node tools/clip-recording.mjs [number] [start] [end]
 * 
 * ... where [number] is the session number (recording must exist), [start] is
 * the start time in seconds at which to start the clip (it may be 0), and
 * [end] the end time in seconds at which to stop the clip (it may be omitted
 * to keep the recording until the end.
 *
 * Pre-requisites:
 * 1. Recording must have been uploaded to Cloudflare with a name that starts
 * with a well-known prefix.
 * 2. The well-known prefix must appear in a RECORDING_PREFIX env variable.
 * 3. Cloudflare account info must appear in CLOUDFLARE_ACCOUNT and
 * CLOUDFLARE_TOKEN env variables.
 *
 * The tool assumes that the recordings are named prefix-xx.mp4, where xx is
 * the breakout session number. It won't be able to find the recording on
 * Cloudflare if that's not the case.
 * 
 * The tool keeps the unclipped recording on Cloudflare, renaming it by adding
 * an "unclipped-" prefix. This is meant to try another clip if needed. Beware
 * though, before the tool may be run again on a recording, the new recording
 * needs to be deleted on Cloudflare and the old one renamed to its original
 * name (without the "unclipped-" prefix).
 */

import path from 'path';
import fs from 'fs/promises';
import { getEnvKey } from './lib/envkeys.mjs';
import webvtt from 'webvtt-parser';

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
      title: v.meta.name,
      videoId: v.uid,
      preview: v.preview,
      embedUrl: v.preview.replace(/watch$/, 'iframe'),
      captions: v.preview.replace(/watch$/, 'captions/en'),
      duration: v.duration
    }))
    .sort((v1, v2) => v1.name.localeCompare(v2.name));
  return recordings;
}

async function clipCaptions(url, start, end) {
  const response = await fetch(url);
  const captions = await response.text();
  const parser = new webvtt.WebVTTParser();
  const serializer = new webvtt.WebVTTSerializer();
  const {cues} = parser.parse(captions);
  const updatedCues = cues
    .filter(cue => cue.tree.children.length)
    .filter(cue => cue.startTime >= start)
    .filter(cue => cue.startTime <= end)
    .map(cue => {
      cue.startTime -= start;
      if (cue.endTime > end) {
        cue.endTime = end;
      }
      cue.endTime -= start;
      return cue;
    });
  return serializer.serialize(updatedCues);
}

async function renameRecording(recording, accountId, authToken) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/${recording.videoId}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({
        uid: recording.videoId,
        meta: {
          name: 'unclipped-' + recording.name
        }
      }, null, 2)
    }
  );
  const json = await response.json();
  if (!json.success) {
    throw new Error('Recording could not be renamed');
  }
}

async function clipOnCloudflare(recording, start, end, accountId, authToken) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/clip`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({
        clippedFromVideoUID: recording.videoId,
        startTimeSeconds: start,
        endTimeSeconds: end ?? recording.duration,
        meta: {
          name: recording.name
        },
        // Consider that a screenshot taken after 1% of the meeting
        // will be a good thumbnail
        thumbnailTimestampPct: 0.01
      }, null, 2)
    });
  const json = await response.json();
  if (!json.success) {
    throw new Error('Recording could not be clipped on Cloudflare');
  }
  return json.result.uid;
}

async function uploadCaptions(captions, recording, accountId, authToken) {
  const formData = new FormData();
  const blob = new Blob([captions], { type : 'text/plain' });
  formData.append('file', blob, 'recording-${recording.sessionId}-en.vtt');
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/${recording.videoId}/captions/en`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${authToken}`
      },
      body: formData
    });
  const json = await response.json();
  if (!json.success) {
    throw new Error('Could not upload captions');
  }
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitUntilReady(recording, accountId, authToken) {
  async function isReady() {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/${recording.videoId}`,
      {
        headers: {
          'Authorization': `Bearer ${authToken}`
        }
      }
    );
    const json = await response.json();
    if (json.result.status && json.result.status.state === 'ready') {
      return true;
    }
    else {
      await sleep(10000);
      return isReady();
    }
  }
  return isReady();
}

async function clipRecording(recording, start, end, accountId, authToken) {
  // Step 1: Retrieve and clip recording captions locally
  console.log('- clip captions');
  const captions = await clipCaptions(recording.captions, start, end ?? recording.duration);

  // Step 2: Give the former recording a new prefix on Cloudflare so that it does not interfere
  console.log('- rename former recording');
  await renameRecording(recording, accountId, authToken);
  
  // Step 3: Clip the recording on Cloudflare, creating a new recording
  console.log('- clip recording on Cloudflare');
  recording.videoId = await clipOnCloudflare(recording, start, end, accountId, authToken);

  // Step 4: Wait for new recording to be ready
  console.log('- wait until new recording is ready');
  const timeoutPromise = new Promise(resolve => {
    setTimeout(resolve, 1200000, 'timeout');
  });
  const readyPromise = waitUntilReady(recording, accountId, authToken);
  const result = await Promise.race([timeoutPromise, readyPromise]);
  if (result === 'timeout') {
    throw new Error('Timeout waiting for videos to get clipped');
  }

  // Step 5: Upload clipped captions to Cloudflare linked to the new recording
  console.log('- upload captions');
  await uploadCaptions(captions, recording, accountId, authToken);
}

async function main(number, start, end) {
  console.log('Find recording...');
  const CLOUDFLARE_ACCOUNT = await getEnvKey('CLOUDFLARE_ACCOUNT');
  const CLOUDFLARE_TOKEN = await getEnvKey('CLOUDFLARE_TOKEN');
  const RECORDING_PREFIX = await getEnvKey('RECORDING_PREFIX');
  const recordings = await listRecordings(CLOUDFLARE_ACCOUNT, CLOUDFLARE_TOKEN, `${RECORDING_PREFIX}-${number}.mp4`);
  if (recordings.length !== 1) {
    throw new Error('Could not find recording');
  }
  const recording = recordings[0];
  console.log(`- found recording: ${recording.videoId}`);
  console.log('Find recording... done');

  console.log();
  console.log('Clip recording...');
  if (start === null || start === end || start >= recording.duration || (end && start > end)) {
    console.log('- no clip requested, keeping previous video');
  }
  else {
    await clipRecording(recording, start, end, CLOUDFLARE_ACCOUNT, CLOUDFLARE_TOKEN);
  }
  console.log('Clip recording... done');
}

const number = process.argv[2];
const start = process.argv[3] ? parseFloat(process.argv[3]) : null;
const end = process.argv[4] ? parseFloat(process.argv[4]) : null;

main(number, start, end).then(_ => process.exit(0));