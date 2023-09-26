/**
 * This tool is only useful once there are Zoom recordings of the breakout
 * sessions available. It pulls and renames the recordings from local storage.
 *
 * To run the tool:
 *
 *  node tools/rename-recordings.mjs
 *
 * Pre-requisites:
 * 1. Zoom recordings must have been downloaed to a local folder, with one
 * subfolder per recording. The subfolder name must start with the session
 * number followed by a "-", e.g., "10-ecija" (the rest does not matter).
 * 2. The local folder must appear in a RECORDING_FOLDER_RAW env variable.
 * 3. The prefix to use to rename the recordings must be in a RECORDING_PREFIX
 * env variable.
 *
 * The tool assumes that the video file to use each time has a name that ends
 * with "_Recording_wwwwxhhhh.mp4".
 * 
 * The tool also extracts the captions file, provided that its name ends with
 * "_Recording.transcript.vtt".
 * 
 * Renamed recordings and captions file are saved at the root of the
 * RECORDING_FOLDER_RAW folder.
 */

import path from 'path';
import fs from 'fs/promises';
import { getEnvKey } from './lib/envkeys.mjs';

async function main() {
  const RECORDING_FOLDER_RAW = await getEnvKey('RECORDING_FOLDER_RAW');
  const RECORDING_PREFIX = await getEnvKey('RECORDING_PREFIX');
  const folders = await fs.readdir(RECORDING_FOLDER_RAW);
  for (const folder of folders) {
    if (folder.includes('.')) {
      continue;
    }
    let files = await fs.readdir(path.join(RECORDING_FOLDER_RAW, folder));
    const prefix = `${RECORDING_PREFIX}-${folder.split('-')[0]}`;

    const recording = files.find(f => f.match(/_Recording_\d{3,4}x\d{3,4}\.mp4$/));
    if (recording) {
      await fs.copyFile(
        path.join(RECORDING_FOLDER_RAW, folder, recording),
        path.join(RECORDING_FOLDER_RAW, prefix + '.mp4'));
    }

    const subtitles = files.find(f => f.match(/_Recording\.transcript\.vtt$/));
    if (subtitles) {
      await fs.copyFile(
        path.join(RECORDING_FOLDER_RAW, folder, subtitles),
        path.join(RECORDING_FOLDER_RAW, prefix + '.vtt'));
    }
  }
}

main().then(_ => process.exit(0));