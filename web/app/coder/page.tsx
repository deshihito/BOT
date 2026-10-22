import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import CoderClient from "./CoderClient";

export const metadata = { title: "AGO Coder | AGOBOT" };

export default async function CoderPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return <CoderClient />;
}
