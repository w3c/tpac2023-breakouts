/**
 * This tool reports information about breakout session chairs.
 *
 * To run the tool:
 *
 *  node tools/list-chairs.mjs
 */

import { getEnvKey } from './lib/envkeys.mjs';
import { fetchProject } from './lib/project.mjs'
import { validateGrid } from './lib/validate.mjs';

async function main() {
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
  const errors = await validateGrid(project)
  console.log(`Retrieve project ${PROJECT_OWNER}/${PROJECT_NUMBER}... done`);

  const sessions = project.sessions.filter(session => session.chairs);
  sessions.sort((s1, s2) => s1.number - s2.number);

  const chairs = sessions
    .map(session => session.chairs)
    .flat()
    .filter((chair, index, list) => list.findIndex(c =>
      c.name === chair.name || c.login === chair.login || c.w3cId === chair.w3cId) === index);

  function formatChair(chair) {
    const parts = [];
    if (chair.name && chair.email) {
      parts.push(`${chair.name} <${chair.email}>`);
    }
    else if (chair.name) {
      parts.push(`${chair.name}`);
    }
    if (chair.login) {
      parts.push(`https://github.com/${chair.login}`);
    }
    if (chair.w3cId) {
      parts.push(`https://www.w3.org/users/${chair.w3cId}`);
    }
    return parts.join(' ');
  }

  console.log();
  console.log('All chairs');
  console.log('----------');
  for (const chair of chairs) {
    console.log(formatChair(chair));
  }

  console.log();
  console.log('All emails');
  console.log('----------');
  const emails = chairs
    .filter(chair => chair.email)
    .map(chair => `${chair.name} <${chair.email}>`)
  console.log(emails.join(', '));

  console.log();
  console.log('Per session');
  console.log('-----------');
  for (const session of sessions) {
    console.log(`#${session.number} - ${session.title}`);
    for (const chair of session.chairs) {
      console.log(formatChair(chair));
    }
    console.log();
  }
}

main()
  .catch(err => {
    console.log(`Something went wrong: ${err.message}`);
    throw err;
  });