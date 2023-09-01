/**
 * This tool suggests a grid that could perhaps work given known constraints.
 *
 * To run the tool:
 *
 *  node tools/suggest-grid.mjs [preservelist or all or none] [exceptlist or none] [apply] [seed]
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
 * [seed] is the seed string to shuffle the array of sessions.
 *
 * Assumptions:
 * - All rooms are of equal quality
 * - Some slots may be seen as preferable
 *
 * Goals:
 * - Where possible, sessions that belong to the same track should take place
 * in the same room. Because a session may belong to two tracks, this is not
 * an absolute goal.
 * - Schedule sessions back-to-back to avoid gaps.
 * - Favor minimizing travels over using different rooms.
 * - Session issue number should not influence slot and room (early proponents
 * should not be favored or disfavored).
 * - Minimize the number of rooms used in parallel.
 * - Only one session labeled for a given track at the same time.
 * - Only one session with a given chair at the same time.
 * - No identified conflicting sessions at the same time.
 * - Meet duration preference.
 * - Meet capacity preference.
 *
 * The tool schedules as many sessions as possible, skipping over sessions that
 * it cannot schedule due to a confict that it cannot resolve.
 */

import { getEnvKey } from './lib/envkeys.mjs';
import { fetchProject, assignSessionsToSlotAndRoom } from './lib/project.mjs'
import { validateSession } from './lib/validate.mjs';
import seedrandom from 'seedrandom';

/**
 * Helper function to shuffle an array
 */
function shuffle(array, seed) {
  const randomGenerator = seedrandom(seed);
  for (let i = array.length - 1; i > 0; i--) {
    let j = Math.floor(randomGenerator.quick() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

/**
 * Helper function to generate a random seed
 */
function makeseed() {
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  return [1, 2, 3, 4, 5]
    .map(_ => chars.charAt(Math.floor(Math.random() * chars.length)))
    .join('');
}

async function main({ preserve, except, apply, seed }) {
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
  seed = seed ?? makeseed();
  shuffle(sessions, seed);
  console.log(`- shuffled sessions with seed "${seed}" to: ${sessions.map(s => s.number).join(', ')}`);
  console.log(`Retrieve project ${PROJECT_OWNER}/${PROJECT_NUMBER} and session(s)... done`);

  // Consider that default capacity is "average number of people" to avoid assigning
  // sessions to too small rooms
  for (const session of sessions) {
    if (session.description.capacity === 0) {
      session.description.capacity = 30;
    }
  }

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

  function chooseTrackRoom(track) {
    if (!track) {
      // No specific room by default for sessions in the main track
      return null;
    }
    const trackSessions = sessions.filter(s => s.tracks.includes(track));

    // Find the session in the track that requires the largest room
    const largestSession = trackSessions.reduce(
      (smax, scurr) => (scurr.description.capacity > smax.description.capacity) ? scurr : smax,
      trackSessions[0]
    );

    const slotsTaken = room => room.sessions.reduce(
      (total, curr) => curr.track === track ? total : total + 1,
      0);
    const byAvailability = (r1, r2) => slotsTaken(r1) - slotsTaken(r2);
    const meetCapacity = room => room.capacity >= largestSession.description.capacity;
    const meetSameRoom = room => slotsTaken(room) + trackSessions.length <= slots.length;
    const meetAll = room => meetCapacity(room) && meetSameRoom(room);

    const requestedRoomsSet = new Set();
    trackSessions
      .filter(s => s.room)
      .forEach(s => requestedRoomsSet.add(s.room));
    const requestedRooms = [...requestedRoomsSet]
      .map(name => rooms.find(room => room.name === name));
    const allRooms = []
      .concat(requestedRooms.sort(byAvailability))
      .concat(rooms.filter(room => !requestedRooms.includes(room)).sort(byAvailability))
    const room =
      allRooms.find(meetAll) ??
      allRooms.find(meetCapacity) ??
      allRooms.find(meetSameRoom) ??
      allRooms[0];
    return room;
  }


  function setRoomAndSlot(session, {
    trackRoom, strictDuration, meetDuration, meetCapacity, meetConflicts
  }) {
    const byCapacity = (r1, r2) => r1.capacity - r2.capacity;
    const byCapacityDesc = (r1, r2) => r2.capacity - r1.capacity;
    const possibleRooms = [];
    if (session.room) {
      // Keep room already assigned
      possibleRooms.push(rooms.find(room => room.name === session.room));
    }
    else if (trackRoom) {
      // Need to assign the session to the track room
      possibleRooms.push(trackRoom);
    }
    else {
      // All rooms that have enough capacity are candidate rooms
      possibleRooms.push(...rooms
        .filter(room => room.capacity >= session.description.capacity)
        .sort(byCapacity));
      if (!meetCapacity) {
        possibleRooms.push(...rooms
          .filter(room => room.capacity < session.description.capacity)
          .sort(byCapacityDesc));
      }
    }

    if (possibleRooms.length === 0) {
      return false;
    }

    for (const room of possibleRooms) {
      const possibleSlots = [];
      if (session.slot) {
        possibleSlots.push(slots.find(slot => slot.name === session.slot));
      }
      else {
        possibleSlots.push(...slots
          .filter(slot => !room.sessions.find(session => session.slot === slot.name)));
        if (!trackRoom) {
          // When not considering a specific track, fill slots in turn,
          // starting with least busy ones
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
        }
      }

      function nonConflictingSlot(slot) {
        const potentialConflicts = sessions.filter(s => s.slot === slot.name);
        // There must be no session in the same track at that time
        const trackConflict = potentialConflicts.find(s =>
          s.tracks.find(track => session.tracks.includes(track)));
        if (trackConflict && meetConflicts.includes('track')) {
          return false;
        }

        // There must be no session chaired by the same chair at that time
        const chairConflict = potentialConflicts.find(s =>
          s.chairs.find(c1 => session.chairs.find(c2 =>
            (c1.login && c1.login === c2.login) ||
            (c1.name && c1.name === c2.name)))
        );
        if (chairConflict) {
          return false;
        }

        // There must be no conflicting sessions at the same time.
        if (session.description.conflicts && meetConflicts.includes('session')) {
          const sessionConflict = potentialConflicts.find(s =>
            session.description.conflicts.includes(s.number));
          if (sessionConflict) {
            return false;
          }
        }

        // Meet duration preference unless we don't care
        if (meetDuration) {
          if ((strictDuration && slot.duration !== session.description.duration) ||
              (!strictDuration && slot.duration < session.description.duration)) {
            return false;
          }
        }

        return true;
      }

      const slot = possibleSlots.find(nonConflictingSlot);
      if (slot) {
        if (!session.room) {
          session.room = room.name;
          room.sessions.push(session);
        }
        if (!session.slot) {
          session.slot = slot.name;
          slot.sessions.push(session);
        }
        return true;
      }
    }

    return false;
  }

  // Proceed on a track-by-track basis, and look at sessions in each track in
  // turn. Choose slot, then choose room. If no room is available, try with a
  // different slot until we find a pair of slot and room that works.
  for (const track of tracks) {
    const trackRoom = chooseTrackRoom(track);
    if (track) {
      console.log(`Schedule sessions in track "${track}" favoring room "${trackRoom.name}"...`);
    }
    else {
      console.log(`Schedule sessions in main track...`);
    }
    let session = selectNextSession(track);
    while (session) {
      const constraints = {
        trackRoom,
        strictDuration: true,
        meetDuration: true,
        meetCapacity: true,
        meetConflicts: ['session', 'track']
      };
      while (!setRoomAndSlot(session, constraints)) {
        if (constraints.strictDuration) {
          console.log(`- relax duration comparison for #${session.number}`);
          constraints.strictDuration = false;
        }
        else if (constraints.trackRoom) {
          console.log(`- relax track constraint for #${session.number}`);
          constraints.trackRoom = null;
        }
        else if (constraints.meetDuration) {
          console.log(`- forget duration constraint for #${session.number}`);
          constraints.meetDuration = false;
        }
        else if (constraints.meetCapacity) {
          console.log(`- forget capacity constraint for #${session.number}`);
          constraints.meetCapacity = false;
        }
        else if (constraints.meetConflicts.length === 2) {
          console.log(`- forget session conflicts for #${session.number}`);
          constraints.meetConflicts = ['track'];
        }
        else if (constraints.meetConflicts[0] === 'track') {
          console.log(`- forget track conflicts for #${session.number}`);
          constraints.meetConflicts = ['session'];
        }
        else if (constraints.meetConflicts.length > 0) {
          console.log(`- forget all conflicts for #${session.number}`);
          constraints.meetConflicts = [];
        }
        else {
          console.log(`- [WARNING] could not find a room and slot for #${session.number}`);
          break;
        }
      }
      if (session.room && session.slot) {
        console.log(`- assigned #${session.number} to room ${session.room} and slot ${session.slot}`);
      }
      session = selectNextSession(track);
    }
    if (track) {
      console.log(`Schedule sessions in track "${track}" favoring room "${trackRoom.name}"... done`);
    }
    else {
      console.log(`Schedule sessions in main track... done`);
    }
  }

  sessions.sort((s1, s2) => s1.number - s2.number);

  console.log();
  console.log('Grid - by slot');
  console.log('--------------');
  for (const slot of slots) {
    console.log(slot.name);
    for (const session of slot.sessions) {
      const tracks = session.tracks.length ? ' - ' + session.tracks.join(', ') : '';
      console.log(`- ${session.room}: #${session.number} ${session.title}${tracks}`);
    }
  }

  console.log();
  console.log('Grid - by room');
  console.log('--------------');
  for (const room of rooms) {
    console.log(room.name);
    for (const session of room.sessions) {
      const tracks = session.tracks.length ? ' - ' + session.tracks.join(', ') : '';
      console.log(`- ${session.slot}: #${session.number} ${session.title}${tracks}`);
    }
  }

  console.log();
  console.log('Grid - by session');
  console.log('-----------------');
  for (const session of sessions) {
    const tracks = session.tracks.length ? ' - ' + session.tracks.join(', ') : '';
    if (session.slot && session.room) {
      const room = rooms.find(room => room.name === session.room);
      console.log(`#${session.number} > ${session.slot} ${room.label} (${room.capacity})${tracks}`);
    }
    else {
      console.log(`#${session.number} > [WARNING] could not be scheduled${tracks}`);
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

const apply = process.argv[4] === 'apply';
const seed = process.argv[5] ?? undefined;

main({ preserve, except, apply, seed })
  .catch(err => {
    console.log(`Something went wrong: ${err.message}`);
    throw err;
  });