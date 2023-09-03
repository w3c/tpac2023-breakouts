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
  console.warn();
  console.warn(`Retrieve project ${PROJECT_OWNER}/${PROJECT_NUMBER}...`);
  const project = await fetchProject(PROJECT_OWNER, PROJECT_NUMBER);
  if (!project) {
    throw new Error(`Project ${PROJECT_OWNER}/${PROJECT_NUMBER} could not be retrieved`);
  }
  project.chairsToW3CID = CHAIR_W3CID;
  console.warn(`- found ${project.sessions.length} sessions`);
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
  console.warn(`- found ${sessions.length} valid sessions among them: ${sessions.map(s => s.number).join(', ')}`);
  shuffle(sessions, seed);
  console.warn(`- shuffled sessions with seed "${seed}" to: ${sessions.map(s => s.number).join(', ')}`);
  console.warn(`Retrieve project ${PROJECT_OWNER}/${PROJECT_NUMBER} and session(s)... done`);

  // Consider that default capacity is "average number of people" to avoid assigning
  // sessions to too small rooms
  for (const session of sessions) {
    if (session.description.capacity === 0) {
      session.description.capacity = 30;
    }
  }

  const rooms = project.rooms;
  const slots = project.slots;

  seed = seed ?? makeseed();

  // Save initial grid algorithm settings as CLI params
  const cli = {};
  if (preserve === 'all') {
    cli.preserve = 'all';
  }
  else if (preserve.length === 0) {
    cli.preserve = 'none';
  }
  else {
    cli.preserve = preserve.join(',');
  }
  if (!except) {
    cli.except = 'none';
  }
  else if (except.length > 0) {
    cli.except = except.join(',');
  }
  else {
    cli.except = 'none';
  }
  cli.seed = seed;
  cli.apply = apply;
  cli.cmd = `node tools/suggest-grid.mjs ${cli.preserve} ${cli.except} ${cli.seed}`;

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
        const potentialConflicts = sessions.filter(s =>
          s !== session && s.slot === slot.name);
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
        if (meetConflicts.includes('session')) {
          const sessionConflict = potentialConflicts.find(s =>
            session.description.conflicts?.includes(s.number) ||
            s.description.conflicts?.includes(session.number));
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
      console.warn(`Schedule sessions in track "${track}" favoring room "${trackRoom.name}"...`);
    }
    else {
      console.warn(`Schedule sessions in main track...`);
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
          console.warn(`- relax duration comparison for #${session.number}`);
          constraints.strictDuration = false;
        }
        else if (constraints.trackRoom) {
          console.warn(`- relax track constraint for #${session.number}`);
          constraints.trackRoom = null;
        }
        else if (constraints.meetDuration) {
          console.warn(`- forget duration constraint for #${session.number}`);
          constraints.meetDuration = false;
        }
        else if (constraints.meetCapacity) {
          console.warn(`- forget capacity constraint for #${session.number}`);
          constraints.meetCapacity = false;
        }
        else if (constraints.meetConflicts.length === 2) {
          console.warn(`- forget session conflicts for #${session.number}`);
          constraints.meetConflicts = ['track'];
        }
        else if (constraints.meetConflicts[0] === 'track') {
          console.warn(`- forget track conflicts for #${session.number}`);
          constraints.meetConflicts = ['session'];
        }
        else if (constraints.meetConflicts.length > 0) {
          console.warn(`- forget all conflicts for #${session.number}`);
          constraints.meetConflicts = [];
        }
        else {
          console.warn(`- [WARNING] could not find a room and slot for #${session.number}`);
          break;
        }
      }
      if (session.room && session.slot) {
        console.warn(`- assigned #${session.number} to room ${session.room} and slot ${session.slot}`);
      }
      session = selectNextSession(track);
    }
    if (track) {
      console.warn(`Schedule sessions in track "${track}" favoring room "${trackRoom.name}"... done`);
    }
    else {
      console.warn(`Schedule sessions in main track... done`);
    }
  }

  sessions.sort((s1, s2) => s1.number - s2.number);

  console.warn();
  console.warn('Grid - by slot');
  console.warn('--------------');
  for (const slot of slots) {
    console.warn(slot.name);
    for (const session of slot.sessions) {
      const tracks = session.tracks.length ? ' - ' + session.tracks.join(', ') : '';
      console.warn(`- ${session.room}: #${session.number} ${session.title}${tracks}`);
    }
  }

  console.warn();
  console.warn('Grid - by room');
  console.warn('--------------');
  for (const room of rooms) {
    console.warn(room.name);
    for (const session of room.sessions) {
      const tracks = session.tracks.length ? ' - ' + session.tracks.join(', ') : '';
      console.warn(`- ${session.slot}: #${session.number} ${session.title}${tracks}`);
    }
  }

  console.warn();
  console.warn('Grid - by session');
  console.warn('-----------------');
  for (const session of sessions) {
    const tracks = session.tracks.length ? ' - ' + session.tracks.join(', ') : '';
    if (session.slot && session.room) {
      const room = rooms.find(room => room.name === session.room);
      console.warn(`#${session.number} > ${session.slot} ${room.label} (${room.capacity})${tracks}`);
    }
    else {
      console.warn(`#${session.number} > [WARNING] could not be scheduled${tracks}`);
    }
  }

  function logIndent(tab, str) {
    let spaces = '';
    while (tab > 0) {
      spaces += '  ';
      tab -= 1;
    }
    console.log(spaces + str);
  }

  console.warn();
  console.warn('Grid - by room in HTML');
  logIndent(0, `<html>
  <head>
    <meta charset="utf-8">
    <title>TPAC schedule</title>
    <style>
      .conflict-error { color: red; background-color: yellow; }
      .capacity-error { background-color: yellow; }
      .track-error { background-color: orange; }
    </style>
  </head>
  <body>
    <table border=1>
      <tr>
        <th></th>`);
  for (const room of rooms) {
    logIndent(4, '<th>' + room.name + '</th>');
  }
  logIndent(3, '</tr>');
  // Build individual rows
  const tablerows = [];
  for (const slot of slots) {
    const tablerow = [slot.name];
    for (const room of rooms) {
      const session = sessions.filter(s => s.slot === slot.name && s.room === room.name).pop();
      tablerow.push(session);
    }
    tablerows.push(tablerow);
  }
  // Format rows (after header row)
  for (const row of tablerows) {
    // Format the row header (the time slot)
    logIndent(3, '<tr>');
    logIndent(4, '<th>');
    logIndent(5, row[0]);

    // Warn of any conflicting chairs in this slot (in first column)
    // let allchairnames = row.filter((s,i) => i > 0).filter((s) => typeof(s) === 'object').map((s) => s.chairs).flat(1).map(c => c.name);
    // let duplicates = allchairnames.filter((e, i, a) => a.indexOf(e) !== i);
    // if (duplicates.length) {
    //   logIndent(5, '<p>Chair conflicts: '' + duplicates.join(', '') + '</p>');
    // }

    // Warn if two sessions from the same track are scheduled in this slot
    const alltracks = row.filter((s, i) => i > 0 && !!s).map(s => s.tracks).flat(1);
    const trackdups = alltracks.filter((e, i, a) => a.indexOf(e) !== i);
    if (trackdups.length) {
      logIndent(5, '<p class="track-error">Same track: ' + trackdups.join(', ') + '</p>');
    }
    logIndent(4, '</th>');
    // Format rest of row
    for (let i = 1; i<row.length; i++) {
      const session = row[i];
      if (!session) {
        logIndent(4, '<td></td>');
      } else {
        // Warn if session capacity estimate exceeds room capacity
        const sloterrors = [];
        if (session.description.capacity > rooms[i-1].capacity) {
          sloterrors.push('capacity-error');
        }
        if (trackdups.length && trackdups.some(r => session.tracks.includes(r))) {
          sloterrors.push('track-error');
        }
        if (sloterrors.length) {
          logIndent(4, '<td class="' + sloterrors.join(' ') + '">');
        } else {
          logIndent(4, '<td>');
        }
        const url= 'https://github.com/' + session.repository + '/issues/' + session.number;
        // Format session number (with link to GitHub) and name
        logIndent(5, `<a href="${url}">#${session.number}</a>: ${session.title}`);

        // Format chairs
        logIndent(5, '<p>');
        logIndent(6, '<i>' + session.chairs.map(x => x.name).join(',<br/>') + '</i>');
        logIndent(5, '</p>');

        // List session conflicts to avoid and highlight where there is a conflict.
        if (Array.isArray(session.description.conflicts)) {
          const confs = [];
          for (const conflict of session.description.conflicts) {
            for (const v of row) {
              if (!!v && v.number === conflict) {
                confs.push(conflict);
              }
            }
          }
          if (confs.length) {
            logIndent(5, '<p><b>Conflicts with</b>: ' + confs.map(s => '<span class="conflict-error">' + s + '</span>').join(', ') + '</p>');
          }
          // This version prints all conflict info if we want that
          // logIndent(5, '<p><b>Conflicts</b>: ' + session.description.conflicts.map(s => confs.includes(s) ? '<span class="conflict-error">' + s + '</span>' : s).join(', ') + '</p>');
        }
        if (sloterrors.includes('capacity-error')) {
          logIndent(5, '<p><b>Capacity</b>: ' + session.description.capacity + '</p>');
        }
        logIndent(4, '</td>');
      }
    }
    logIndent(3, '</tr>');
  }
  logIndent(2, '</table>');

  // If any sessions have not been assigned to a room, warn us.
  const unscheduled = sessions.filter(s => !s.slot || !s.room);
  if (unscheduled.length) {
    logIndent(2, '<h2>Unscheduled sessions</h2>');
    logIndent(2, '<p>' + unscheduled.map(s => '#' + s.number).join(', ') + '</p>');
  }

  const preserveInPractice = (preserve !== 'all' && preserve.length > 0) ?
    ' (in practice: ' + preserve.sort((n1, n2) => n1 - n2).join(',') + ')' :
    '';
  logIndent(2, '<h2>Generation parameters</h2>');
  logIndent(2, `<ul>
      <li>preserve: ${cli.preserve}${preserveInPractice}</li>
      <li>except: ${cli.except}</li>
      <li>seed: ${cli.seed}</li>
      <li>apply: ${cli.apply}</li>
    </ul>
    <p>Command-line command:</p>
    <pre><code>${cli.cmd}</code></pre>`);
  logIndent(1, '</body>');
  logIndent(0, '</html>');

  console.warn();
  console.warn('To re-generate the grid, run:');
  console.warn(cli.cmd);

  if (apply) {
    console.warn();
    const sessionsToUpdate = sessions.filter(s => s.updated);
    for (const session of sessionsToUpdate) {
      console.warn(`- updating #${session.number}...`);
      await assignSessionsToSlotAndRoom(session, project);
      console.warn(`- updating #${session.number}... done`);
    }
  }
}


// Read preserve list from command-line
let preserve;
if (process.argv[2]) {
  if (!process.argv[2].match(/^all|none|\d+(,\d+)*$/)) {
    console.warn('Command needs to receive a list of issue numbers as first parameter or "all"');
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
    console.warn('Command needs to receive a list of issue numbers as second parameter or "none"');
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
    console.warn(`Something went wrong: ${err.message}`);
    throw err;
  });
