/**
 * This tool validates a session issue and manages labels accordingly.
 *
 * To run the tool:
 *
 *  node tools/validate-session.mjs [sessionNumber] [changes]
 *
 * where [sessionNumber] is the number of the issue to validate (e.g. 15)
 * and [changes] is the filename of a JSON file that describes changes made to
 * the body of the issue (e.g. changes.json).
 *
 * The JSON file should look like:
 * {
 *   "body": {
 *     "from": "[previous version]"
 *   }
 * }
 *
 * The JSON file typically matches github.event.issue.changes in a GitHub job.
 */

import { getEnvKey } from './lib/envkeys.mjs';
import { fetchProject } from './lib/project.mjs'
import { validateSession } from './lib/validate.mjs';
import { parseSessionBody, updateSessionLabels } from './lib/session.mjs';
import { sendGraphQLRequest } from './lib/graphql.mjs';

async function main(sessionNumber, changesFile) {
  // First, retrieve known information about the project and the session
  const PROJECT_OWNER = await getEnvKey('PROJECT_OWNER');
  const PROJECT_NUMBER = await getEnvKey('PROJECT_NUMBER');
  const CHAIR_W3CID = await getEnvKey('CHAIR_W3CID', {}, true);
  console.log();
  console.log(`Retrieve project ${PROJECT_OWNER}/${PROJECT_NUMBER}...`);
  const project = await fetchProject(PROJECT_OWNER, PROJECT_NUMBER);
  const session = project.sessions.find(s => s.number === sessionNumber);
  if (!project) {
    throw new Error(`Project ${PROJECT_OWNER}/${PROJECT_NUMBER} could not be retrieved`);
  }
  if (!session) {
    throw new Error(`Session ${sessionNumber} not found in project ${PROJECT_OWNER}/${PROJECT_NUMBER}`);
  }
  console.log(`- ${project.sessions.length} sessions`);
  console.log(`- ${project.rooms.length} rooms`);
  console.log(`- ${project.slots.length} slots`);
  console.log(`- ${project.labels.length} labels`);
  project.chairsToW3CID = CHAIR_W3CID;
  console.log(`Retrieve project ${PROJECT_OWNER}/${PROJECT_NUMBER}... done`);

  console.log();
  console.log(`Validate session...`);
  let report = await validateSession(sessionNumber, project, changes);
  for (const error of report) {
    console.log(`- ${error.severity}:${error.type}: ${error.messages.join(', ')}`);
  }
  console.log(`Validate session... done`);

  const checkComments = report.find(error =>
    error.severity === 'check' && error.type === 'comments');
  if (checkComments &&
      !session.labels.includes('check: comments') &&
      changesFile) {
    // The session contains comments and does not have a "check: comments"
    // label. That said, an admin may already have validated these comments
    // (and removed the label). We should only add it back if the comments
    // section changed.
    console.log();
    console.log(`Assess need to add "check: comments" label...`);

    // Read JSON file that describes changes if one was given
    // (needs to contain a dump of `github.event.changes` when run in a job)
    const { default: changes } = await import(
      ['..', changesFile].join('/'),
      { assert: { type: 'json' } }
    );
    if (!changes.body?.from) {
      console.log(`- no previous version of session body, add label`);
    }
    else {
      console.log(`- previous version of session body found`);
      try {
        const previousDescription = parseSessionBody(changes.body.from);
        const newDescription = parseSessionBody(session.body);
        if (newDescription.comments === previousDescription.comments) {
          console.log(`- no change in comments section, no need to add label`);
          report = report.filter(error =>
            !(error.severity === 'check' && error.type === 'comments'));
        }
        else {
          console.log(`- comments section changed, add label`);
        }
      }
      catch {
        // Previous version could not be parsed. Well, too bad, let's add
        // the "check: comments" label then.
        // TODO: consider doing something smarter as broken format errors
        // will typically arise when author adds links to agenda/minutes.
        console.log(`- previous version of session body could not be parsed, add label`);
      }
    }
    console.log(`Assess need to add "check: comments" label... done`);
  }

  // Time to compute label changes.
  // All labels that are not checks, warnings, or errors are preserved.
  console.log();
  console.log(`Update labels on session...`);
  const newLabels = report
    .map(error => `${error.severity}: ${error.type}`)
    .sort();
  await updateSessionLabels(session, project, newLabels);
  console.log(`Update labels on session... done`);
}


// Read session number from command-line
if (!process.argv[2] || !process.argv[2].match(/^\d+$/)) {
  console.log('Command needs to receive a session number as first parameter');
  process.exit(1);
}
const sessionNumber = parseInt(process.argv[2], 10);

// Read change filename from command-line if specified
const changes = process.argv[3];

main(sessionNumber, changes)
  .catch(err => {
    console.log(`Something went wrong: ${err.message}`);
    throw err;
  });