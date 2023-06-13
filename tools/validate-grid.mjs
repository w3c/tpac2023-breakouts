/**
 * This tool validates the grid and sets a few labels accordingly. Unless user
 * requests full re-validation of the sessions, labels managed by the tool are
 * those related to scheduling problems (in other words, problems that may
 * arise when an admin chooses a room and slot).
 *
 * To run the tool:
 *
 *  node tools/validate-grid.mjs [validation]
 *
 * where [validation] is either "scheduling" (default) to validate only
 * scheduling conflicts or "everything" to re-validate all sessions.
 */

import { getEnvKey } from './lib/envkeys.mjs';
import { fetchProject } from './lib/project.mjs'
import { validateGrid } from './lib/validate.mjs';
import { updateSessionLabels } from './lib/session.mjs';
import { sendGraphQLRequest } from './lib/graphql.mjs';

const schedulingErrors = [
 'error: scheduling',
 'warning: capacity',
 'warning: conflict',
 'warning: duration',
 'warning: track'
];

async function main(validation) {
  // First, retrieve known information about the project and the session
  const PROJECT_OWNER = await getEnvKey('PROJECT_OWNER');
  const PROJECT_NUMBER = await getEnvKey('PROJECT_NUMBER');
  console.log();
  console.log(`Retrieve project ${PROJECT_OWNER}/${PROJECT_NUMBER}...`);
  const project = await fetchProject(PROJECT_OWNER, PROJECT_NUMBER);
  if (!project) {
    throw new Error(`Project ${PROJECT_OWNER}/${PROJECT_NUMBER} could not be retrieved`);
  }
  console.log(`- ${project.sessions.length} sessions`);
  console.log(`- ${project.rooms.length} rooms`);
  console.log(`- ${project.slots.length} slots`);
  console.log(`- ${project.labels.length} labels`);
  console.log(`Retrieve project ${PROJECT_OWNER}/${PROJECT_NUMBER}... done`);

  console.log();
  console.log(`Validate grid...`);
  const errors = (await validateGrid(project))
    .filter(error => validation === 'everything' || schedulingErrors.includes(`${error.severity}: ${error.type}`));
  console.log(`- ${errors.length} problems found`);
  console.log(`Validate grid... done`);

  // Time to compute label changes for each session
  const sessions = [... new Set(errors.map(error => error.session))]
    .map(number => project.sessions.find(s => s.number === number));
  for (const session of sessions) {
    console.log();
    console.log(`Update labels on session ${session.number}...`);
    const newLabels = errors
      .filter(error => error.session === session.number)
      .map(error => `${error.severity}: ${error.type}`)
      .sort();
    await updateSessionLabels(session, project, newLabels);
    console.log(`Update labels on session ${session.number}... done`);
  }
}


main(process.argv[2] ?? 'scheduling')
  .catch(err => {
    console.log(`Something went wrong: ${err.message}`);
    throw err;
  });