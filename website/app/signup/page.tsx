import { Suspense } from "react";
import AuthForm from "../auth-form";

export default function SignupPage() {
  return <Suspense fallback={<main className="auth-page"><p>Loading registration…</p></main>}><AuthForm mode="signup" /></Suspense>;
}
