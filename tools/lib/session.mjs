import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as YAML from 'yaml';
import { fileURLToPath } from 'url';
import { sendGraphQLRequest } from './graphql.mjs';
import { todoStrings } from './todostrings.mjs';
const __dirname = fileURLToPath(new URL('.', import.meta.url));


/**
 * The list of sections that may be found in a session body and, for each of
 * them, a `validate` function to validate the format of the section and a
 * `parse` function to return interpreted values.
 *
 * The list needs to be populated once and for all through a call to the async
 * `initSectionHandlers` function, which reads section info from the
 * `session.yml` file.
 */
let sectionHandlers = null;


/**
 * Populate the list of section handlers from the info in `session.yml`.
 *
 * The function needs to be called once before `parseSessionBody` or
 * `validateSessionBody` may be called (function returns immediately on
 * further calls).
 */
export async function initSectionHandlers() {
  if (sectionHandlers) {
    return;
  }
  const yamlTemplate = await readFile(
    path.join(__dirname, '..', '..', '.github', 'ISSUE_TEMPLATE', 'session.yml'),
    'utf8');
  const template = YAML.parse(yamlTemplate);
  sectionHandlers = template.body
    .filter(section => !!section.id)
    .map(section => {
      const handler = {
        id: section.id,
        title: section.attributes.label.replace(/ \(Optional\)$/, ''),
        required: !!section.validations?.required,
        validate: value => true,
        parse: value => value,
        serialize: value => value
      };
      if (section.type === 'dropdown') {
        handler.options = section.attributes.options;
        handler.validate = value => handler.options.includes(value);
      }
      else if (section.type === 'input') {
        handler.validate = value => !value.match(/\n/)
      }
      return handler;
    })
    .map(handler => {
      // Add custom validation constraints and parse/serialize logic
      // Ideally, this logic would be encoded in session.yml but GitHub rejects
      // additional properties in issue template files.
      switch (handler.id) {

      case 'description':
        // TODO: validate that markdown remains simple enough
        break;

      case 'chairs':
        // List of GitHub identities... or of actual names
        // Space-separated values are possible when there are only GitHub
        // identities. Otherwise, CSV, line-separated or markdown lists.
        handler.parse = value => value
          .split(/[\n,]/)
          .map(nick => nick.trim())
          .map(nick => nick.replace(/^-\s*(.*)$/, '$1'))
          .filter(nick => !!nick)
          .map(nick => {
            if (nick.startsWith('@')) {
              return nick
                .split(/\s/)
                .map(n => n.trim())
                .map(n => { return { login: n.substring(1) }; });
            }
            else {
              return { name: nick };
            }
          })
          .flat();
        handler.validate = value => {
          const chairs = value
            .split(/[\n,]/)
            .map(nick => nick.trim())
            .map(nick => nick.replace(/^-\s*(.*)$/, '$1'))
            .filter(nick => !!nick)
            // TODO: If space-separated list, all nicks must start with "@"
            .map(nick => nick.startsWith('@') ? nick.split(/\s/) : nick)
            .flat();
          return chairs.every(nick => nick.match(/^(@[A-Za-z0-9][A-Za-z0-9\-]+|[^@]+)$/));
        }
        handler.serialize = value => value
          .map(nick => nick.login ? `@${nick.login}` : nick.name)
          .join(', ');
        break;

      case 'shortname':
        handler.validate = value => value.match(/^#?[A-Za-z0-9\-_]+$/);
        break;

      case 'attendance':
        handler.parse = value => value === 'Restricted to TPAC registrants' ?
          'restricted' : 'public';
        handler.serialize = value => value === 'restricted' ?
          'Restricted to TPAC registrants' : 'Anyone may attend (Default)';
        break;

      case 'duration':
        handler.parse = value => value === '30 minutes' ? 30 : 60;
        handler.serialize = value => value === 30 ? '30 minutes' : '60 minutes (Default)';
        break;

      case 'conflicts':
        // List of GitHub issues
        handler.parse = value => value.split(/[\s,]/)
          .map(issue => issue.trim())
          .filter(issue => !!issue)
          .map(issue => parseInt(issue.substring(1), 10));
        handler.validate = value => {
          const conflictingSessions = value
            .split(/[\s,]/)
            .map(issue => issue.trim())
            .filter(issue => !!issue);
          return conflictingSessions.every(issue => issue.match(/^#\d+$/));
        };
        handler.serialize = value => value.map(issue => `#${issue}`).join(', ');
        break;

      case 'capacity':
        handler.parse = value => {
          switch (value) {
          case 'Don\'t know (Default)': return 0;
          case 'Fewer than 20 people': return 15;
          case '20-45 people': return 30;
          case 'More than 45 people': return 50;
          };
        };
        handler.serialize = value => {
          switch (value) {
          case 0: return 'Don\'t know (Default)';
          case 15: return 'Fewer than 20 people';
          case 30: return '20-45 people';
          case 50: return 'More than 45 people';
          }
        }
        break;

      case 'materials':
        const capitalize = str => str.slice(0, 1).toUpperCase() + str.slice(1);
        handler.parse = value => {
          const materials = {};
          value.split('\n')
            .map(line => line.trim())
            .filter(line => !!line)
            .map(line =>
              line.match(/^-\s+(Agenda|Slides|Minutes|Calendar):\s*(.*)$/i) ??
              line.match(/^-\s+\[(Agenda|Slides|Minutes|Calendar)\]\((.*)\)$/i))
            .forEach(match => materials[match[1].toLowerCase()] = match[2]);
          return materials;
        };
        handler.validate = value => {
          const matches = value.split('\n')
            .map(line => line.trim())
            .filter(line => !!line)
            .map(line =>
              line.match(/^-\s+(Agenda|Slides|Minutes|Calendar):\s*(.*)$/i) ||
              line.match(/^-\s+\[(Agenda|Slides|Minutes|Calendar)\]\((.*)\)$/i));
          return matches.every(match => {
            if (!match) {
              return false;
            }
            if (!todoStrings.includes(match[2].toUpperCase())) {
              try {
                new URL(match[2]);
                return true;
              }
              catch (err) {
                return false;
              }
            }
            return true;
          });
        }
        handler.serialize = value => Object.entries(value)
          .map(([key, url]) => todoStrings.includes(url) ?
            `- ${capitalize(key)}: ${url}` :
            `- [${capitalize(key)}](${url})`)
          .join('\n');
        break;
      }

      return handler;
    });
}


/**
 * Helper function to split a session issue body (in markdown) into sections
 */
function splitIntoSections(body) {
  return body.split(/^### /m)
    .filter(section => !!section)
    .map(section => section.split(/\r?\n/))
    .map(section => {
      let value = section.slice(1).join('\n\n').trim();
      if (value.replace(/^_(.*)_$/, '$1') === 'No response') {
        value = null;
      }
      return {
        title: section[0].replace(/ \(Optional\)$/, ''),
        value
      };
    });
}


/**
 * Validate the session issue body and return a list of errors (or an empty
 * array if all is fine)
 */
export function validateSessionBody(body) {
  if (!sectionHandlers) {
    throw new Error('Need to call `initSectionHandlers` first!');
  }
  const sections = splitIntoSections(body);
  const errors = sections
    .map(section => {
      const sectionHandler = sectionHandlers.find(handler =>
        handler.title === section.title);
      if (!sectionHandler) {
        return `Unexpected section "${section.title}"`;
      }
      if (!section.value && sectionHandler.required) {
        return `Unexpected empty section "${section.title}"`;
      }
      if (section.value && !sectionHandler.validate(section.value)) {
        return `Invalid content in section "${section.title}"`;
      }
      return null;
    })
    .filter(error => !!error);

  // Also report required sections that are missing
  for (const handler of sectionHandlers) {
    if (handler.required && !sections.find(s => s.title === handler.title)) {
      errors.push(`Missing required section "${handler.title}"`);
    }
  }

  return errors;
}


/**
 * Parse the session issue body and return a structured object with values that
 * describes the session.
 */
export function parseSessionBody(body) {
  if (!sectionHandlers) {
    throw new Error('Need to call `initSectionHandlers` first!');
  }
  const session = {};
  splitIntoSections(body)
    .map(section => {
      const sectionHandler = sectionHandlers.find(handler =>
        handler.title === section.title);
      return {
        id: sectionHandler.id,
        value: section.value || section.value === 0 ?
          sectionHandler.parse(section.value) :
          null
      };
    })
    .forEach(input => session[input.id] = input.value);
  return session;
}


/**
 * Serialize a session description into an issue body
 */
export function serializeSessionDescription(description) {
  if (!sectionHandlers) {
    throw new Error('Need to call `initSectionHandlers` first!');
  }
  return sectionHandlers
    .map(handler => `### ${handler.title}${handler.required ? '' : ' (Optional)'}

${(description[handler.id] || description[handler.id] === 0) ?
    handler.serialize(description[handler.id]) : '_No response_' }`)
    .join('\n\n');
}


/**
 * Update session labels
 */
export async function updateSessionLabels(session, project, newLabels) {
  const sessionLabels = session.labels
    .filter(s =>
      s.startsWith('check: ') ||
      s.startsWith('warning: ') ||
      s.startsWith('error: '))
    .sort();
  console.log(`- session should have ${['session'].concat(newLabels).join(', ')}`);
  console.log(`- session already has ${['session'].concat(sessionLabels).join(', ')}`);

  const labelsToAdd = newLabels
    .filter(label => !sessionLabels.includes(label))
    .map(label => project.labels.find(l => l.name === label).id);
  if (labelsToAdd.length > 0) {
    console.log(`- add label ids ${labelsToAdd.join(', ')}`);
    const res = await sendGraphQLRequest(`mutation {
      addLabelsToLabelable(input: {
        labelableId: "${session.id}",
        labelIds: ${JSON.stringify(labelsToAdd)}
      }) {
        labelable {
          ...on Issue {
            id
          }
        }
      }
    }`);
    if (!res?.data?.addLabelsToLabelable?.labelable?.id) {
      console.log(JSON.stringify(res, null, 2));
      throw new Error(`GraphQL error, could not add labels`);
    }
  }
  else {
    console.log(`- no label to add`);
  }

  const labelsToRemove = sessionLabels
    .filter(label => label !== 'session' && !newLabels.includes(label))
    .map(label => project.labels.find(l => l.name === label).id);
  if (labelsToRemove.length > 0) {
    console.log(`- remove label ids ${labelsToRemove.join(', ')}`);
    const res = await sendGraphQLRequest(`mutation {
      removeLabelsFromLabelable(input: {
        labelableId: "${session.id}",
        labelIds: ${JSON.stringify(labelsToRemove)}
      }) {
        labelable {
          ...on Issue {
            id
          }
        }
      }
    }`);
    if (!res?.data?.removeLabelsFromLabelable?.labelable?.id) {
      console.log(JSON.stringify(res, null, 2));
      throw new Error(`GraphQL error, could not remove labels`);
    }
  }
  else {
    console.log(`- no label to remove`);
  }
}


/**
 * Update session labels
 */
export async function updateSessionDescription(session) {
  const body = serializeSessionDescription(session.description);
  const res = await sendGraphQLRequest(`mutation {
    updateIssue(input: {
      id: "${session.id}",
      body: "${body.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"
    }) {
      issue {
        id
      }
    }
  }`);
  if (!res?.data?.updateIssue?.issue?.id) {
    console.log(JSON.stringify(res, null, 2));
    throw new Error(`GraphQL error, could not update issue body`);
  }
}