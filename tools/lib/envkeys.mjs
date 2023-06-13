let config = null;

/**
 * Retrieve the requested variable from the environment or from the
 * `config.json` file at the root of the repository if it exists.
 * 
 * Function throws if the environment key is missing, unless a default
 * value was provided
 */
export async function getEnvKey(key, defaultValue) {
  if (Object.hasOwn(process.env, key)) {
    return process.env[key];
  }
  try {
    if (!config) {
      const { default: env } = await import(
        '../../config.json',
        { assert: { type: 'json' } }
      );
      config = env;
    }
  }
  catch {
  }
  finally {
    if (config && Object.hasOwn(config, key)) {
      return config[key];
    }
    else if (defaultValue !== undefined) {
      return defaultValue;
    }
    throw new Error(`No ${key} found in environment of config file.`);
  }
}