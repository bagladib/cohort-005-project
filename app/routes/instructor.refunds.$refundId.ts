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

  // 404, 403 and 409 are thrown by decideRefundRequest; an invalid form comes
  // back as field errors for the screen to show.
  if (!result.ok) {
    return data({ ok: false as const, errors: result.errors }, { status: 400 });
  }

  // No mail transport is wired up yet, so the message goes to the server log.
  const { email } = result;
  console.log(`[email] to=${email.to} subject=${email.subject}\n${email.body}`);

  return { ok: true as const, status: result.status };
}
