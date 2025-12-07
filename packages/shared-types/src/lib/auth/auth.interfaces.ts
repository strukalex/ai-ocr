export type Role = 'viewer' | 'validator' | 'operator' | 'admin';

export interface AuthTokens {
  accessToken: string;
  refreshToken?: string;
}

export interface UserContext {
  userId: string;
  roles: Role[];
  email?: string;
  name?: string;
}

