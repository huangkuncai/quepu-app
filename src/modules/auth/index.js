import { defineModule } from '../../shared/module.js';

export { AuthService, parseBearerToken } from './service.js';

export const MODULE = defineModule('auth', 'Identity, sessions, token issuance and account security.');
