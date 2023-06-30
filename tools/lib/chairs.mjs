import { sendGraphQLRequest } from './graphql.mjs';
import { fetchW3CAccount } from './w3caccount.mjs';

/**
 * Retrieve information about session chairs in an array
 *
 * The session chairs include the session issue author and the additional
 * chairs listed as GitHub identities in the issue's body.
 *
 * Returned array contains, for each chair, an object with the user's:
 * - GitHub login (always present)
 * - GitHub avatar URL
 * - GitHub databaseId
 * - W3C account ID
 * - W3C account name
 * - W3C account email
 *
 * The object may only contain the GitHub login if that login cannot be
 * associated with a GitHub account, or GitHub information but no W3C
 * account information if user did not link their GitHub account with their
 * W3C account.
 */
export async function fetchSessionChairs(session, chairs2W3CID) {
  const chairs = [];
  if (session.author) {
    const w3cAccount = await fetchW3CAccount(session.author.databaseId);
    const chair = {
      databaseId: session.author.databaseId,
      avatarUrl: session.author.avatarUrl,
      login: session.author.login
    };
    if (w3cAccount) {
      chair.w3cId = w3cAccount.w3cId;
      chair.name = w3cAccount.name;
      chair.email = w3cAccount.email;
    }
    else if (chairs2W3CID?.[session.author.login]) {
      chair.w3cId = chairs2W3CID[session.author.login];
      chair.name = session.author.login;
    }
    chairs.push(chair);
  }
  if (session.description.chairs) {
    for (const login of session.description.chairs) {
      const githubAccount = await sendGraphQLRequest(`query {
        user(login: "${login}") {
          databaseId
          login
          avatarUrl
        }
      }`);
      const chair = { login };
      if (githubAccount.data.user) {
        chair.databaseId = githubAccount.data.user.databaseId;
        chair.avatarUrl = githubAccount.data.user.avatarUrl;
        const w3cAccount = await fetchW3CAccount(chair.databaseId);
        if (w3cAccount) {
          chair.w3cId = w3cAccount.w3cId;
          chair.name = w3cAccount.name;
          chair.email = w3cAccount.email;
        }
        else if (chairs2W3CID?.[login]) {
          chair.w3cId = chairs2W3CID[login];
          chair.name = login;
        }
      }
      chairs.push(chair);
    }
  }
  return chairs;
}


/**
 * Validate the given list of session chairs, where each chair is represented
 * with an object that follows the same format as that returned by the
 * `fetchSessionChairs` function.
 * 
 * The function returns a list of errors (each error is a string), or an empty
 * array when the list looks fine. The function throws if the list is invalid,
 * in other words if it contains objects that don't have a `login` property.
 */
export function validateSessionChairs(chairs) {
  return chairs
    .map(chair => {
      if (!chair.login) {
        throw new Error('Invalid chair object received in the list to validate');
      }
      if (!chair.databaseId) {
        return `No GitHub account associated with "@${chair.login}"`;
      }
      if (!chair.w3cId) {
        return `No W3C account linked to the "@${chair.login}" GitHub account`;
      }
      return null;
    })
    .filter(error => !!error);
}