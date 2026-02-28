import { NextResponse } from "next/server";

import { buildDashboardSnapshot } from "@/lib/dashboard-data";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const snapshot = await buildDashboardSnapshot();
  return NextResponse.json(snapshot);
}
