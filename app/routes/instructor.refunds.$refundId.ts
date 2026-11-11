import { data } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/instructor.refunds.$refundId";
import { requireUserId } from "~/lib/access.server";
import { parseParams } from "~/lib/validation";
import { decideRefundRequest } from "~/lib/refund-decision";

const paramsSchema = z.object({
  refundId: z.coerce.number().int().positive(),
});

/**
 * Approves or Declines one Refund Request. Posted to by the refund approval
 * screen with `intent` = `approve` | `decline` (and `reason` for decline).
 * The rules live in `~/lib/refund-decision`.
 */
export async function action({ params, request }: Route.ActionArgs) {
  const deciderUserId = await requireUserId(request);
  const { refundId } = parseParams(params, paramsSchema);

  const formData = await request.formData();
  const result = decideRefundRequest(
    refundId,
    deciderUserId,
    Object.fromEntries(formData)
  );

  if (!result.ok) {
    if (result.status === 400) {
      return data(
        { ok: false as const, error: result.error, errors: result.errors ?? {} },
        { status: 400 }
      );
    }
    throw data(result.error, { status: result.status });
  }

  // No mail transport is wired up yet, so the message goes to the server log.
  const { email } = result;
  console.log(`[email] to=${email.to} subject=${email.subject}\n${email.body}`);

  return { ok: true as const, status: result.status };
}
