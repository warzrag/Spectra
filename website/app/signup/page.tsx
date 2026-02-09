"use client";

import { useState } from "react";
import { Shield, ArrowLeft, Loader2, CheckCircle, Eye, EyeOff } from "lucide-react";
import { createUserWithEmailAndPassword } from "firebase/auth";
import { doc, getDoc, setDoc, addDoc, updateDoc, collection } from "firebase/firestore";
import { auth, db } from "../../lib/firebase";

export default function SignupPage() {
  const [inviteCode, setInviteCode] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!inviteCode.trim()) {
      setError("Invite code is required");
      return;
    }
    if (!email.trim() || !password.trim()) {
      setError("All fields are required");
      return;
    }
    if (password.length < 6) {
      setError("Password must be at least 6 characters");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    setLoading(true);

    try {
      // 1. Validate invite code
      const codeRef = doc(db, "inviteCodes", inviteCode.trim().toUpperCase());
      const codeDoc = await getDoc(codeRef);

      if (!codeDoc.exists()) {
        setError("Invalid invite code");
        setLoading(false);
        return;
      }

      const codeData = codeDoc.data();
      if (codeData.used) {
        setError("This invite code has already been used");
        setLoading(false);
        return;
      }

      // 2. Create Firebase Auth account
      const credential = await createUserWithEmailAndPassword(auth, email, password);

      // 3. Determine team: use code's teamId if it exists, otherwise create a new team
      let teamId = codeData.teamId;
      if (!teamId) {
        const teamRef = await addDoc(collection(db, "teams"), {
          name: email,
          ownerId: credential.user.uid,
          createdAt: new Date().toISOString(),
        });
        teamId = teamRef.id;
      }

      // 4. Create user document (role depends on whether joining existing team)
      const role = codeData.teamId ? "va" : "owner";
      await setDoc(doc(db, "users", credential.user.uid), {
        uid: credential.user.uid,
        email: email,
        role,
        teamId,
        createdAt: new Date().toISOString(),
      });

      // 5. Mark invite code as used
      await updateDoc(codeRef, {
        used: true,
        usedBy: credential.user.uid,
        usedByEmail: email,
        usedAt: new Date().toISOString(),
      });

      // 6. Sign out (they'll log in from the desktop app)
      await auth.signOut();

      setSuccess(true);
    } catch (err: any) {
      if (err.code === "auth/email-already-in-use") {
        setError("This email is already registered");
      } else if (err.code === "auth/invalid-email") {
        setError("Invalid email address");
      } else {
        setError(err.message || "Something went wrong");
      }
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4" style={{ background: "#06060b" }}>
        <div className="w-full max-w-md text-center space-y-6">
          <div className="mx-auto w-16 h-16 rounded-2xl flex items-center justify-center" style={{ background: "rgba(16, 185, 129, 0.1)", border: "1px solid rgba(16, 185, 129, 0.2)" }}>
            <CheckCircle size={32} className="text-emerald-400" />
          </div>
          <h1 className="text-2xl font-bold text-white">Account Created!</h1>
          <p className="text-[15px] text-gray-400">
            Your Spectra account has been created successfully. Download the app and log in with your credentials.
          </p>
          <div className="space-y-3">
            <a
              href="/"
              className="block w-full py-3 rounded-xl text-[14px] font-semibold text-white text-center transition-all"
              style={{ background: "linear-gradient(135deg, #6366f1, #8b5cf6)" }}
            >
              Back to Home
            </a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4" style={{ background: "#06060b" }}>
      <div className="w-full max-w-md space-y-8">
        {/* Back link */}
        <a href="/" className="inline-flex items-center gap-2 text-[13px] text-gray-500 hover:text-gray-300 transition-colors">
          <ArrowLeft size={14} />
          Back to home
        </a>

        {/* Header */}
        <div className="text-center space-y-3">
          <div className="mx-auto w-12 h-12 rounded-xl flex items-center justify-center" style={{ background: "linear-gradient(135deg, #6366f1, #8b5cf6)" }}>
            <Shield size={24} className="text-white" />
          </div>
          <h1 className="text-2xl font-bold text-white">Create your account</h1>
          <p className="text-[14px] text-gray-500">Enter your invite code to get started</p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Invite Code */}
          <div>
            <label className="block text-[12px] font-medium text-gray-400 mb-1.5">Invite Code</label>
            <input
              type="text"
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
              placeholder="SPECTRA-XXXXXX"
              className="w-full px-4 py-3 rounded-xl text-[14px] font-mono tracking-wider text-center uppercase transition-all focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
              style={{
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.08)",
                color: "#f0f0f5",
              }}
              required
              autoFocus
            />
          </div>

          {/* Email */}
          <div>
            <label className="block text-[12px] font-medium text-gray-400 mb-1.5">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full px-4 py-3 rounded-xl text-[14px] transition-all focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
              style={{
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.08)",
                color: "#f0f0f5",
              }}
              required
            />
          </div>

          {/* Password */}
          <div>
            <label className="block text-[12px] font-medium text-gray-400 mb-1.5">Password</label>
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 6 characters"
                className="w-full px-4 py-3 rounded-xl text-[14px] transition-all focus:outline-none focus:ring-2 focus:ring-indigo-500/50 pr-11"
                style={{
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,255,255,0.08)",
                  color: "#f0f0f5",
                }}
                required
                minLength={6}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          {/* Confirm Password */}
          <div>
            <label className="block text-[12px] font-medium text-gray-400 mb-1.5">Confirm Password</label>
            <input
              type={showPassword ? "text" : "password"}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Repeat your password"
              className="w-full px-4 py-3 rounded-xl text-[14px] transition-all focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
              style={{
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.08)",
                color: "#f0f0f5",
              }}
              required
              minLength={6}
            />
          </div>

          {/* Error */}
          {error && (
            <div className="px-4 py-3 rounded-xl text-[13px] font-medium text-red-400" style={{ background: "rgba(239, 68, 68, 0.08)", border: "1px solid rgba(239, 68, 68, 0.15)" }}>
              {error}
            </div>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 rounded-xl text-[14px] font-semibold text-white transition-all disabled:opacity-50 flex items-center justify-center gap-2"
            style={{ background: "linear-gradient(135deg, #6366f1, #8b5cf6)" }}
          >
            {loading ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                Creating account...
              </>
            ) : (
              "Create Account"
            )}
          </button>
        </form>

        <p className="text-center text-[12px] text-gray-600">
          Already have an account? Log in from the Spectra desktop app.
        </p>
      </div>
    </div>
  );
}
