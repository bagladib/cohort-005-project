import { useState } from "react";
import { Link, isRouteErrorResponse, useFetcher } from "react-router";
import type { Route } from "./+types/instructor.refunds";
import { requireInstructorOrAdmin } from "~/lib/access.server";
import {
  getRequestedRefundRequests,
  type RequestedRefundRequest,
} from "~/lib/refund-review";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { Label } from "~/components/ui/label";
import { Skeleton } from "~/components/ui/skeleton";
import { Textarea } from "~/components/ui/textarea";
import { AlertTriangle, Check, CheckCircle2, X } from "lucide-react";
import { cn, formatPrice, formatRelativeTime } from "~/lib/utils";

export function meta() {
  return [{ title: "Refund Requests — Cadence" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { userId, isAdmin } = await requireInstructorOrAdmin(request);

  return {
    refundRequests: getRequestedRefundRequests({ userId, isAdmin }),
    isAdmin,
  };
}

const RULE_LABELS: Record<
  keyof RequestedRefundRequest["eligibility"]["rules"],
  string
> = {
  refundWindow: "Requested inside the Refund Window",
  watchTime: "Under 2 hours of video watched",
  completion: "Under half the lessons completed",
  teamSeat: "Not a claimed team seat",
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function EligibilityPanel({
  eligibility,
}: {
  eligibility: RequestedRefundRequest["eligibility"];
}) {
  return (
    <div className="rounded-md border p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">Refund Eligibility</span>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-xs font-medium",
            eligibility.eligible
              ? "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300"
              : "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
          )}
        >
          {eligibility.eligible ? "Eligible" : "Not eligible"}
        </span>
        <span className="text-xs text-muted-foreground">
          Advisory only: you can still Approve or Decline.
        </span>
      </div>
      <ul className="space-y-1 text-sm">
        {(
          Object.keys(RULE_LABELS) as Array<keyof typeof RULE_LABELS>
        ).map((rule) => {
          const passed = eligibility.rules[rule].passed;
          return (
            <li key={rule} className="flex items-center gap-2">
              {passed ? (
                <Check className="size-4 text-green-600" aria-hidden />
              ) : (
                <X className="size-4 text-destructive" aria-hidden />
              )}
              <span className={cn(!passed && "text-destructive")}>
                {RULE_LABELS[rule]}
              </span>
              <span className="sr-only">{passed ? "passes" : "fails"}</span>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-xs text-muted-foreground">
        The Refund Window runs to the end of{" "}
        {formatDate(`${eligibility.lastDayInWindow}T00:00:00`)}. Watching and
        completion are counted up to now.
      </p>
    </div>
  );
}

function RefundRequestCard({
  refundRequest,
}: {
  refundRequest: RequestedRefundRequest;
}) {
  const fetcher = useFetcher();
  const [declineReason, setDeclineReason] = useState("");
  const submitting = fetcher.state !== "idle";
  const decisionPath = `/instructor/refunds/${refundRequest.id}`;

  return (
    <Card>
      <CardContent className="space-y-4 p-6">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="font-medium">{refundRequest.learnerName}</span>
          <span className="text-sm text-muted-foreground">
            {refundRequest.courseTitle}
          </span>
          <span
            className="text-xs text-muted-foreground"
            suppressHydrationWarning
          >
            Requested {formatRelativeTime(refundRequest.requestedAt)}
          </span>
          <span className="ml-auto text-sm font-medium">
            Refundable Amount:{" "}
            {formatPrice(refundRequest.eligibility.refundableAmount)}
          </span>
        </div>

        <blockquote className="border-l-2 pl-3 text-sm italic">
          {refundRequest.reason}
        </blockquote>

        <EligibilityPanel eligibility={refundRequest.eligibility} />

        {refundRequest.earlierDeclined.length > 0 && (
          <div className="text-sm">
            <p className="mb-1 font-medium">
              Earlier Declined Refund Requests on this Purchase
            </p>
            <ul className="space-y-1 text-muted-foreground">
              {refundRequest.earlierDeclined.map((declined) => (
                <li key={declined.id}>
                  <span suppressHydrationWarning>
                    {formatDate(declined.requestedAt)}
                  </span>
                  : &ldquo;{declined.reason}&rdquo;
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex flex-wrap items-start gap-4 border-t pt-4">
          <fetcher.Form method="post" action={decisionPath}>
            <input type="hidden" name="intent" value="approve" />
            <Button type="submit" size="sm" disabled={submitting}>
              Approve
            </Button>
          </fetcher.Form>

          <fetcher.Form
            method="post"
            action={decisionPath}
            className="min-w-64 flex-1 space-y-2"
          >
            <input type="hidden" name="intent" value="decline" />
            <Label htmlFor={`decline-reason-${refundRequest.id}`}>
              Reason for declining (shown to the learner)
            </Label>
            <Textarea
              id={`decline-reason-${refundRequest.id}`}
              name="reason"
              value={declineReason}
              onChange={(event) => setDeclineReason(event.target.value)}
              rows={2}
              required
            />
            <Button
              type="submit"
              size="sm"
              variant="outline"
              disabled={submitting || declineReason.trim().length === 0}
            >
              Decline
            </Button>
          </fetcher.Form>
        </div>
      </CardContent>
    </Card>
  );
}

export default function InstructorRefunds({
  loaderData,
}: Route.ComponentProps) {
  const { refundRequests, isAdmin } = loaderData;

  return (
    <div className="mx-auto max-w-4xl p-6 lg:p-8">
      <nav className="mb-6 text-sm text-muted-foreground">
        {/* /instructor is instructor-only, so admins go back to their own list. */}
        <Link
          to={isAdmin ? "/admin/courses" : "/instructor"}
          className="hover:text-foreground"
        >
          {isAdmin ? "Manage Courses" : "My Courses"}
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">Refund Requests</span>
      </nav>

      <div className="mb-6">
        <h1 className="text-3xl font-bold">Refund Requests</h1>
        <p className="mt-1 text-muted-foreground">
          {isAdmin
            ? "Refund Requests on every course waiting for a decision."
            : "Refund Requests on your courses waiting for your decision."}{" "}
          Refund Eligibility is a guide, not a rule.
        </p>
      </div>

      {refundRequests.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <CheckCircle2 className="mx-auto mb-4 size-12 text-green-600" />
            <p className="font-medium">No Refund Requests waiting</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Every Refund Request has been decided.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {refundRequests.map((refundRequest) => (
            <RefundRequestCard
              key={refundRequest.id}
              refundRequest={refundRequest}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function HydrateFallback() {
  return (
    <div className="mx-auto max-w-4xl p-6 lg:p-8">
      <Skeleton className="mb-6 h-4 w-40" />
      <Skeleton className="mb-2 h-9 w-72" />
      <Skeleton className="mb-6 h-4 w-96" />
      <div className="space-y-4">
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading Refund Requests.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
      message =
        typeof error.data === "string"
          ? error.data
          : "Please select a user from the DevUI panel.";
    } else if (error.status === 403) {
      title = "Not allowed";
      message =
        typeof error.data === "string"
          ? error.data
          : "You don't have access to this page.";
    } else {
      title = `Error ${error.status}`;
      message = typeof error.data === "string" ? error.data : error.statusText;
    }
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <Link to="/instructor">
          <Button>My Courses</Button>
        </Link>
      </div>
    </div>
  );
}
