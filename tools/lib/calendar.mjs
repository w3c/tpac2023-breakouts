import YAML from 'yaml';


/**
 * Convert a session object to the YAML needed to feed the W3C calendar
 *
 * The provided session object must preliminary have been expanded with:
 * - the result of parsing the session issue body with the `parseSessionBody`
 * function, in a `description` property.
 * - information about the author and additional chairs, including their W3C
 * IDs, as returned by the `fetchSessionChairs` function, in a `chairs`
 * property.
 * 
 * The function returns a YAML string, or null if the session has not yet been
 * associated with a slot.
 *
 * The function may throw in unexpected ways if provided session object has not
 * yet been validated.
 */
export function sessionToCalendarEntry(session, project) {
  if (!session.slot) {
    return null;
  }

  const calendarUrl = session.description.materials.Calendar ?? undefined;

  const entry = {
    uuid: calendarUrl ?
      calendarUrl.substring(calendarUrl.lastIndexOf('/')) :
      undefined,
    general: {
      title: session.title,
      description: formatDescription(session),
      location: session.room ? session.room : undefined,
      big_meeting: project.metadata.meeting,
      category: 'breakout-sessions',
      status: 'confirmed',
      visibility: session.description.attendance === 'restricted' ?
        'member' : 'public',
      // TODO: Turn main TPAC breakout organizer ID into a proper parameter
      author: 41989
    },
    dates: {
      start: `${project.metadata.date} ${project.slots.find(s => s.name === session.slot).start}`,
      end: `${project.metadata.date} ${project.slots.find(s => s.name === session.slot).end}`,
      timezone: project.metadata.timezone
    },
    participants: {
      organizers: [session.chairs[0].w3cId],
      individuals: (session.chairs.length > 1) ?
        session.chairs.slice(1).map(p => p.w3cId) :
        undefined
    },
    joining: {
      visibility: session.description.attendance === 'restricted' ?
        'registered' : 'public',
      // TODO: Initialize Zoom info somewhere!
      url: session.room ? project.rooms.find(r => r.name === session.room).zoom : undefined,
      chat: `https://irc.w3.org/?channels=%23${session.description.shortname}`
    },
    agenda: {
      url: session.description.materials.agenda
    }
  };
  if (session.description.materials.minutes) {
    entry.minutes = {
      url: session.description.materials.minutes
    };
  }
  return YAML.stringify(entry);
}


/**
 * Helper function to format calendar entry description from the session's info
 */
function formatDescription(session) {
  let materials = '';
  if (session.description.materials) {
    for (const [key, value] of Object.entries(session.description.materials)) {
      if ((key !== 'Agenda') && (key !== 'Calendar')) {
        materials += `- ${key}: ${value}\n`;
      }
    }
  }
  return `
## Description
${session.description.description}

## Goal(s)
${session.description.goal}

## Materials
${materials}
  `;
}