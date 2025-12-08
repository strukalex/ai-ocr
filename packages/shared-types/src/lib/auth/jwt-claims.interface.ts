import { Role } from './auth.interfaces';

export interface RealmAccess {
  roles?: Role[];
}

export interface ResourceAccess {
  [clientId: string]: {
    roles?: Role[];
  };
}

export interface JwtClaims {
  sub?: string;
  preferred_username?: string;
  email?: string;
  name?: string;
  realm_access?: RealmAccess;
  resource_access?: ResourceAccess;
  roles?: Role[];
  exp?: number;
  iat?: number;
  iss?: string;
  aud?: string | string[];
}

