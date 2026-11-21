import { Suspense } from "react";
import AuthForm from "../auth-form";

export default function LoginPage() {
  return <Suspense fallback={<main className="auth-page"><p>Loading sign in…</p></main>}><AuthForm mode="login" /></Suspense>;
}
