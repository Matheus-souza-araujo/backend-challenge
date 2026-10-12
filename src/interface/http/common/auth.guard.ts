import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { APP_CONFIG, type AppConfig } from '@config/app-config';

export const IS_PUBLIC = 'isPublic';

export const Public = () => SetMetadata(IS_PUBLIC, true);

@Injectable()
export class KeycloakAuthGuard implements CanActivate {
  private jwks?: JWTVerifyGetKey;

  constructor(
    private readonly reflector: Reflector,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic || !this.config.auth.enabled) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Token Bearer ausente');
    }

    try {
      const { payload } = await jwtVerify(
        header.slice('Bearer '.length),
        this.getJwks(),
        {
          issuer: this.config.auth.issuer,
          audience: this.config.auth.audience,
        },
      );
      (request as Request & { auth?: unknown }).auth = payload;
      return true;
    } catch {
      throw new UnauthorizedException('Token inválido ou expirado');
    }
  }

  private getJwks(): JWTVerifyGetKey {
    this.jwks ??= createRemoteJWKSet(new URL(this.config.auth.jwksUri));
    return this.jwks;
  }
}
