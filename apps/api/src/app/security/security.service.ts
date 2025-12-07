import { Injectable } from '@nestjs/common';
import { SecurityConfig, securityConfig } from '../../config/security.config';

@Injectable()
export class SecurityConfigService {
  get config(): SecurityConfig {
    return securityConfig;
  }
}

