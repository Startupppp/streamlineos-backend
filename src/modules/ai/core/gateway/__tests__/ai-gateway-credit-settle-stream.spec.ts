import { settleStream } from '../ai-gateway-credit.helper';
import { computeTokenCharge } from '../../billing/ai-model-pricing.constants';
import type { AiCreditLedger } from '../credit-ledger.interface';
import type { TrackAiUsageParams } from '../../services/ai-usage.service';

const MODEL = 'gpt-4o-mini';
const ORG_ID = 'org_abc';
const USER_ID = 'user_xyz';
const FEATURE = 'ai:chat';
const RESERVATION_ID = 77;
const PROMPT_TOKENS = 120;
const COMPLETION_TOKENS = 60;

function mockLedger(): jest.Mocked<AiCreditLedger> {
  return {
    reserve: jest.fn().mockResolvedValue({ reservationId: RESERVATION_ID }),
    settle: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
  } as jest.Mocked<AiCreditLedger>;
}

function mockUsageSvc(): { track: jest.MockedFunction<(p: TrackAiUsageParams) => Promise<void>> } {
  return { track: jest.fn().mockResolvedValue(undefined) };
}

describe('settleStream — shared streaming settlement seam', () => {
  describe('charge routing', () => {
    it('settles the reservation with the milli-credit charge computed by computeTokenCharge', async () => {
      const ledger = mockLedger();
      const usageSvc = mockUsageSvc();
      const { milliCredits, costUsd } = computeTokenCharge(MODEL, PROMPT_TOKENS, COMPLETION_TOKENS);

      await settleStream(ledger, usageSvc, {
        reservationId: RESERVATION_ID,
        model: MODEL,
        promptTokens: PROMPT_TOKENS,
        completionTokens: COMPLETION_TOKENS,
        orgId: ORG_ID,
        userId: USER_ID,
        feature: FEATURE,
      });

      expect(ledger.settle).toHaveBeenCalledWith(RESERVATION_ID, {
        orgId: ORG_ID,
        actualMilli: milliCredits,
        model: MODEL,
        promptTokens: PROMPT_TOKENS,
        completionTokens: COMPLETION_TOKENS,
        totalTokens: PROMPT_TOKENS + COMPLETION_TOKENS,
        costUsd,
      });
    });

    it('tracks usage with the same token counts and computed milli credits', async () => {
      const ledger = mockLedger();
      const usageSvc = mockUsageSvc();
      const { milliCredits } = computeTokenCharge(MODEL, PROMPT_TOKENS, COMPLETION_TOKENS);

      await settleStream(ledger, usageSvc, {
        reservationId: RESERVATION_ID,
        model: MODEL,
        promptTokens: PROMPT_TOKENS,
        completionTokens: COMPLETION_TOKENS,
        orgId: ORG_ID,
        userId: USER_ID,
        feature: FEATURE,
      });

      expect(usageSvc.track).toHaveBeenCalledWith({
        orgId: ORG_ID,
        userId: USER_ID,
        feature: FEATURE,
        model: MODEL,
        promptTokens: PROMPT_TOKENS,
        completionTokens: COMPLETION_TOKENS,
        creditsMilli: milliCredits,
      });
    });

    it('does not settle when the settle call is removed — mutation guard', async () => {
      const ledger = mockLedger();
      const usageSvc = mockUsageSvc();

      await settleStream(ledger, usageSvc, {
        reservationId: RESERVATION_ID,
        model: MODEL,
        promptTokens: PROMPT_TOKENS,
        completionTokens: COMPLETION_TOKENS,
        orgId: ORG_ID,
        userId: USER_ID,
        feature: FEATURE,
      });

      expect(ledger.settle).toHaveBeenCalledTimes(1);
    });
  });
});
