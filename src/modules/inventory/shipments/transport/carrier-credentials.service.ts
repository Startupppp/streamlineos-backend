import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { invCarriers } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { CacheService } from "../../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../../common/cache/cache-keys";
import { InventoryAuditService } from "../../stock-engine/inventory-audit.service";
import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
  maskSecretHint,
} from "../../../../common/security/secret-encryption.util";
import { checkWebhookUrl } from "../../../../common/security/ssrf-guard";
import { CarrierTransportRegistry } from "./carrier-transport.registry";
import type { SetCarrierCredentialsInput } from "../dto/carrier-transport.schemas";
import type { CarrierAccount } from "./carrier-transport.port";

/**
 * INV-26 — where a tenant's courier account lives, and what may come back out.
 *
 * ## Why the row and not an environment variable
 *
 * `inv_carriers` is org-scoped, so each tenant defines its own couriers and
 * holds its own courier account. One deployment-wide variable would hand every
 * tenant the same login, and would make "revoke this customer's carrier key" a
 * redeploy. An earlier note on this ticket said the blocker was a missing
 * environment variable; that was structurally wrong and is not undone here.
 *
 * ## What protects it
 *
 * AES-256-GCM at rest through `secret-encryption.util`, which is the same
 * helper `workflow_secrets` uses — one implementation, not a second one with
 * different mistakes in it. `ENCRYPTION_KEY` is a validated environment
 * variable and `encryptSecret` throws rather than storing plaintext when it is
 * absent, so a misconfigured node fails the write instead of quietly saving the
 * key in the clear.
 *
 * ## What may come out
 *
 * Plaintext leaves this class in exactly one direction: into a
 * `CarrierAccount` handed to an adapter for the length of one call. It is never
 * returned to a caller, never audited, never logged. What an administrator gets
 * back is `maskSecretHint` — "****3f9a", the last four characters — which is
 * enough to answer "is the key I pasted the one that is installed" and not
 * enough to reconstruct anything. The audit row records *that* a credential was
 * replaced and by whom, with the hint and never the value.
 *
 * The read side is enforced structurally rather than by care: `CARRIER_COLUMNS`
 * in `carriers.service.ts` is the projection every carrier read goes through,
 * and neither ciphertext column appears in it.
 */

/** What a carrier row has to carry for a call to be possible at all. */
export interface CarrierTransportRow {
  readonly id: number;
  readonly code: string;
  readonly transport: string | null;
  readonly apiBaseUrl: string | null;
  readonly apiCredentialEncrypted: string | null;
  readonly webhookSecretEncrypted: string | null;
}

/**
 * Why a carrier cannot be called, as a value.
 *
 * A missing credential is an ordinary configuration state — a carrier created
 * this morning that nobody has finished setting up — and the operator's screen
 * should say which half is missing rather than showing a stack trace.
 */
export type CarrierAccountResolution =
  | { readonly ok: true; readonly account: CarrierAccount }
  | { readonly ok: false; readonly reason: string };

@Injectable()
export class CarrierCredentialsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: InventoryAuditService,
    private readonly registry: CarrierTransportRegistry,
  ) {}

  /**
   * Install or replace this tenant's courier account.
   *
   * A partial write is meaningful: an administrator rotating only the webhook
   * secret sends only that field, and the API key is left alone rather than
   * cleared. Sending an explicit `null` clears one.
   */
  async setCredentials(
    orgId: string,
    userId: string,
    carrierId: number,
    input: SetCarrierCredentialsInput,
  ): Promise<{ carrierId: number; apiCredentialHint: string | null; webhookSecretSet: boolean }> {
    const [existing] = await this.db
      .select({
        id: invCarriers.id,
        apiCredentialHint: invCarriers.apiCredentialHint,
        webhookSecretEncrypted: invCarriers.webhookSecretEncrypted,
      })
      .from(invCarriers)
      .where(and(eq(invCarriers.orgId, orgId), eq(invCarriers.id, carrierId)))
      .limit(1);
    // A carrier in another tenant is a 404, never a 403: a 403 on somebody
    // else's id confirms the record exists.
    if (!existing) throw new NotFoundException("Carrier not found");

    // An unknown transport must not reach the column. `forTransport` answers
    // null for one it does not know, and a row carrying a transport nobody
    // implements is a carrier that silently never books — the failure would
    // surface as "nothing happens", which is the worst kind.
    if (input.transport) {
      const known = this.registry.knownTransports();
      if (!this.registry.forTransport(input.transport)) {
        throw new BadRequestException(
          `Unknown carrier transport "${input.transport}". Known: ${known.join(", ") || "none"}.`,
        );
      }
    }

    // Checked here as well as on every call. Refusing at write time is what
    // turns a typo into an error message an administrator sees while they are
    // looking at the form, rather than into a booking that fails at 06:00.
    if (input.apiBaseUrl) {
      const guard = await checkWebhookUrl(input.apiBaseUrl);
      if (!guard.allowed) {
        throw new BadRequestException(
          `That carrier endpoint is not reachable from here (${guard.reason}).`,
        );
      }
    }

    const patch: Record<string, string | null> = {};
    if (input.transport !== undefined) patch.transport = input.transport;
    if (input.apiBaseUrl !== undefined) patch.apiBaseUrl = input.apiBaseUrl;
    if (input.apiCredential !== undefined) {
      patch.apiCredentialEncrypted =
        input.apiCredential === null ? null : encryptSecret(input.apiCredential);
      patch.apiCredentialHint =
        input.apiCredential === null ? null : maskSecretHint(input.apiCredential);
    }
    if (input.webhookSecret !== undefined) {
      patch.webhookSecretEncrypted =
        input.webhookSecret === null ? null : encryptSecret(input.webhookSecret);
    }

    const [updated] = await this.db.transaction(async (tx) => {
      const rows = await tx
        .update(invCarriers)
        .set(patch)
        .where(and(eq(invCarriers.orgId, orgId), eq(invCarriers.id, carrierId)))
        .returning({
          id: invCarriers.id,
          apiCredentialHint: invCarriers.apiCredentialHint,
          webhookSecretEncrypted: invCarriers.webhookSecretEncrypted,
        });
      // The audit records the ACT, never the value — not even the ciphertext,
      // which would put a decryptable copy of every rotation in a table read by
      // a different permission.
      await this.audit.insert(tx, {
        orgId,
        actorUserId: userId,
        action: "carrier.credentials-set",
        resourceType: "carrier",
        resourceId: String(carrierId),
        metadata: {
          transportSet: input.transport !== undefined,
          apiBaseUrlSet: input.apiBaseUrl !== undefined,
          apiCredentialChanged: input.apiCredential !== undefined,
          webhookSecretChanged: input.webhookSecret !== undefined,
          apiCredentialHint: rows[0]?.apiCredentialHint ?? null,
        },
      });
      return rows;
    });

    await this.cache.invalidateNamespace(CACHE_KEYS.invCarriersNamespace(orgId));
    return {
      carrierId,
      apiCredentialHint: updated?.apiCredentialHint ?? null,
      webhookSecretSet: Boolean(updated?.webhookSecretEncrypted),
    };
  }

}

/**
 * The account an adapter needs, decrypted, or the reason there isn't one.
 *
 * A free function rather than a method because it uses no state: it takes the
 * carrier row the caller has already loaded — alongside the shipment, in one
 * query — and reads it. Keeping it out of the class is what lets the webhook
 * receiver read a secret without injecting a service whose only other job is
 * writing one, and is why neither of its callers has to stand up a cache to
 * decrypt a string.
 */
export function resolveCarrierAccount(carrier: CarrierTransportRow): CarrierAccountResolution {
  if (!carrier.apiBaseUrl) {
    return { ok: false, reason: "This carrier has no API endpoint configured." };
  }
  if (!carrier.apiCredentialEncrypted) {
    return { ok: false, reason: "This carrier has no API credential installed." };
  }
  if (!isEncryptedSecret(carrier.apiCredentialEncrypted)) {
    // Stored plaintext would mean something wrote round `setCredentials`.
    // Refusing is right: using it would send a key that is already compromised.
    return { ok: false, reason: "This carrier's credential is not stored encrypted." };
  }
  return {
    ok: true,
    account: {
      carrierCode: carrier.code,
      baseUrl: carrier.apiBaseUrl,
      credential: decryptSecret(carrier.apiCredentialEncrypted),
    },
  };
}

/**
 * The shared secret a callback from this carrier must be signed with.
 *
 * Null when none is installed, and null when what is stored is not ciphertext
 * — a plaintext secret in that column would mean something wrote round
 * `setCredentials`, and verifying against it would accept callbacks signed with
 * a secret that is sitting in the clear in the database.
 */
export function carrierWebhookSecret(carrier: CarrierTransportRow): string | null {
  const stored = carrier.webhookSecretEncrypted;
  if (!stored || !isEncryptedSecret(stored)) return null;
  return decryptSecret(stored);
}
