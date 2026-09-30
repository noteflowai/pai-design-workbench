import { AlbJwtVerifier } from "aws-jwt-verify";
import type { Config } from "./config.js";

/** Only trust signed claims from the configured ALB, pool and application client. */
export function authentication(config: Config) {
  const verifier = config.albAuth ? AlbJwtVerifier.create(config.albAuth) : undefined;
  return async (headers: Record<string, string | string[] | undefined>): Promise<boolean> => {
    if (!verifier) return true;
    const token = headers["x-amzn-oidc-data"], identity = headers["x-amzn-oidc-identity"];
    if (typeof token !== "string" || token.length > 20_000 || typeof identity !== "string") return false;
    try {
      const claims = await verifier.verify(token);
      return typeof claims.sub === "string" && claims.sub === identity;
    } catch {
      return false;
    }
  };
}
