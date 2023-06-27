/**
 * This tool suggests a grid that could perhaps work given known constraints.
 *
 * To run the tool:
 *
 *  node tools/suggest-grid.mjs [preservelist or all or none] [exceptlist or none] [apply]
 *
 * where [preservelist or all] is a comma-separated (no spaces) list of session
 * numbers whose assigned slots and rooms must be preserved. Or "all" to
 * preserve all slots and rooms that have already been assigned. Or "none" not
 * to preserve anything.
 * 
 * [exceptlist or none] only makes sense when the preserve list is "all" and
 * allows to specify a comma-separated (no spaces) list of session numbers whose
 * assigned slots and rooms are to be discarded. Or "none" to say "no exception,
 * preserve info in all sessions".
 * 
 * [apply] is "apply" if you want to apply the suggested grid on GitHub.
 * 
 * Overall rules:
 * 1. Minimize the number of rooms used in parallel.
 * 2. Only one session labeled for a given track at the same time.
 * 3. Only one session with a given chair at the same time.
 * 4. No conflicting sessions at the same time.
 * 5. Meet duration preference.
 * 6. Meet capacity preference.
 * 7. Spread sessions across rooms (i.e., use any given room minimally)
 * 8. Schedule as many sessions as possible.
 */

import { getEnvKey } from './lib/envkeys.mjs';
import { fetchProject, assignSessionsToSlotAndRoom } from './lib/project.mjs'
import { validateSession } from './lib/validate.mjs';

async function main({ preserve, except, apply }) {
  const PROJECT_OWNER = await getEnvKey('PROJECT_OWNER');
  const PROJECT_NUMBER = await getEnvKey('PROJECT_NUMBER');
  const CHAIR_W3CID = await getEnvKey('CHAIR_W3CID', {}, true);
  console.log();
  console.log(`Retrieve project ${PROJECT_OWNER}/${PROJECT_NUMBER}...`);
  const project = await fetchProject(PROJECT_OWNER, PROJECT_NUMBER);
  if (!project) {
    throw new Error(`Project ${PROJECT_OWNER}/${PROJECT_NUMBER} could not be retrieved`);
  }
  project.chairsToW3CID = CHAIR_W3CID;
  console.log(`- found ${project.sessions.length} sessions`);
  let sessions = await Promise.all(project.sessions.map(async session => {
    const sessionErrors = (await validateSession(session.number, project))
      .filter(err =>
        err.severity === 'error' &&
        err.type !== 'chair conflict' &&
        err.type !== 'scheduling');
    if (sessionErrors.length > 0) {
      return null;
    }
    return session;
  }));
  sessions = sessions.filter(s => !!s);
  sessions.sort((s1, s2) => s1.number - s2.number);
  console.log(`- found ${sessions.length} valid sessions among them: ${sessions.map(s => s.number).join(', ')}`);
  console.log(`Retrieve project ${PROJECT_OWNER}/${PROJECT_NUMBER} and session(s)... done`);

  const rooms = project.rooms;
  const slots = project.slots;

  if (preserve === 'all') {
    preserve = sessions.filter(s => s.slot || s.room).map(s => s.number);
  }
  if (except) {
    preserve = preserve.filter(s => !except.includes(s.number));
  }
  if (!preserve) {
    preserve = [];
  }
  for (const session of sessions) {
    if (!preserve.includes(session.number)) {
      session.slot = undefined;
      session.room = undefined;
    }
  }

  // Initialize the list of tracks
  const tracks = new Set();
  for (const session of sessions) {
    session.tracks = session.labels
      .filter(label => label.startsWith('track: '))
      .map(label => label.substring('track: '.length))
      .map(track => {
        tracks.add(track);
        return track;
      });
  }
  tracks.add('');

  // Initalize the views by slot and by room
  for (const slot of slots) {
    slot.pos = slots.indexOf(slot);
    slot.sessions = sessions.filter(s => s.slot === slot.name);
  }
  for (const room of rooms) {
    room.pos = rooms.indexOf(room);
    room.sessions = sessions.filter(s => s.room === room.name);
  }

  // Return next session to process (and flag it as processed)
  function selectNextSession(track) {
    const session = sessions.find(s => !s.processed &&
      (track === '' || s.tracks.includes(track)));
    if (session) {
      session.processed = true;
    }
    return session;
  }

  function chooseSlot(session, after = { pos: -1 }) {
    // Keep assigned slot if so requested
    if (session.slot && preserve.includes(session.number)) {
      return;
    }

    // Only consider slots that are after the last considered one
    // and prefer slots that have fewer sessions.
    const possibleSlots = slots.filter(slot => slot.pos > after.pos);
    possibleSlots.sort((s1, s2) => {
      const s1len = s1.sessions.length;
      const s2len = s2.sessions.length;
      if (s1len === s2len) {
        return s1.pos - s2.pos;
      }
      else {
        return s1len - s2len;
      }
    });

    // Find first non-conflicting slot
    const slot = possibleSlots.find(slot => {
      const potentialConflicts = sessions.filter(s => s.slot === slot.name);
      // There must be no session in the same track at that time
      const trackConflict = potentialConflicts.find(s =>
        s.tracks.find(track => session.tracks.includes(track)));
      if (trackConflict) {
        return false;
      }

      // There must be no session chaired by the same chair at that time
      const chairConflict = potentialConflicts.find(s =>
        s.description.chairs.find(c1 =>
          session.description.chairs.find(c1 => c1.login === c2.login)));
      if (chairConflict) {
        return false;
      }

      // There must be no conflicting sessions at the same time.
      if (session.description.conflicts) {
        const sessionConflict = potentialConflicts.find(s =>
          session.description.conflicts.includes(s.number));
        if (sessionConflict) {
          return false;
        }
      }

      // Meet duration preference
      if (slot.duration !== session.description.duration) {
        return false;
      }

      return true;
    });

    if (slot) {
      session.slot = slot.name;
      session.updated = true;
      slot.sessions.push(session);
      console.log(`- assign #${session.number} to slot ${slot.name}`);
    }
    else {
      console.log(`- could not find a slot for #${session.number}`);
    }

    return slot;
  }

  function chooseRoom(session) {
    // Keep assigned room if so requested
    // and no way to choose a room if slot has not been set yet!
    if (session.room && preserve.includes(session.number)) {
      return;
    }
    if (!session.slot) {
      return;
    }

    // Prefer rooms that have fewer sessions assigned to them
    const possibleRooms = rooms.slice();
    possibleRooms.sort((s1, s2) => {
      const s1len = s1.sessions.length;
      const s2len = s2.sessions.length;
      if (s1len === s2len) {
        return s1.pos - s2.pos;
      }
      else {
        return s1len - s2len;
      }
    });

    // Find first suitable room
    const room = possibleRooms.find(room => {
      // Meet capacity preference
      if (session.description.capacity) {
        if (room.capacity < session.description.capacity) {
          return false;
        }
      }
      return true;
    });

    if (room) {
      session.room = room.name;
      session.updated = true;
      room.sessions.push(session);
      console.log(`- assign #${session.number} to room ${room.name}`);
    }
    else {
      console.log(`- could not find a room during slot ${session.slot} for #${session.number}`);
    }

    return room;
  }

  // Proceed on a track-by-track basis, and look at sessions in each track in
  // turn. Choose slot, then choose room. If no room is available, try with a
  // different slot until we find a pair of slot and room that works.
  for (const track of tracks) {
    let session = selectNextSession(track);
    while (session) {
      let slot = chooseSlot(session);
      while (slot) {
        const room = chooseRoom(session);
        slot = room ? undefined : chooseSlot(session, slot);
      }
      session = selectNextSession(track);
    }
  }

  console.log();
  console.log('Grid - by slot');
  console.log('--------------');
  for (const slot of slots) {
    console.log(slot.name);
    for (const session of slot.sessions) {
      console.log(`- ${session.room}: #${session.number} ${session.title}`);
    }
  }

  console.log();
  console.log('Grid - by room');
  console.log('--------------');
  for (const room of rooms) {
    console.log(room.name);
    for (const session of room.sessions) {
      console.log(`- ${session.slot}: #${session.number} ${session.title}`);
    }
  }

  console.log();
  console.log('Grid - by session');
  console.log('-----------------');
  for (const session of sessions) {
    if (session.slot && session.room) {
      console.log(`#${session.number} - ${session.slot} - ${session.room}`);
    }
    else {
      console.log(`#${session.number} - [WARNING] could not be scheduled`);
    }
  }

  if (apply) {
    console.log();
    const sessionsToUpdate = sessions.filter(s => s.updated);
    for (const session of sessionsToUpdate) {
      console.log(`- updating #${session.number}...`);
      await assignSessionsToSlotAndRoom(session, project);
      console.log(`- updating #${session.number}... done`);
    }
  }
}


// Read preserve list from command-line
let preserve;
if (process.argv[2]) {
  if (!process.argv[2].match(/^all|none|\d+(,\d+)*$/)) {
    console.log('Command needs to receive a list of issue numbers as first parameter or "all"');
    process.exit(1);
  }
  if (process.argv[2] === 'all') {
    preserve = 'all';
  }
  else if (process.argv[2] === 'none') {
    preserve = [];
  }
  else {
    preserve = process.argv[2].map(n => parseInt(n, 10));
  }
}

// Read except list
let except;
if (process.argv[3]) {
  if (!process.argv[3].match(/^none|\d+(,\d+)*$/)) {
    console.log('Command needs to receive a list of issue numbers as second parameter or "none"');
    process.exit(1);
  }
  except = process.argv[3] === 'none' ?
    undefined :
    process.argv[3].map(n => parseInt(n, 10));
}

let apply = process.argv[4] === 'apply';

main({ preserve, except, apply })
  .catch(err => {
    console.log(`Something went wrong: ${err.message}`);
    throw err;
  });