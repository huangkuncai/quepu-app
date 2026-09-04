const MODULE_NAME = /^[a-z][a-z0-9-]*$/;

export function defineModule(name, boundary) {
  if (!MODULE_NAME.test(name)) throw new TypeError(`Invalid module name: ${name}`);
  if (typeof boundary !== 'string' || boundary.length === 0) {
    throw new TypeError(`Module ${name} needs a boundary description`);
  }
  return Object.freeze({ name, status: 'skeleton', boundary });
}
