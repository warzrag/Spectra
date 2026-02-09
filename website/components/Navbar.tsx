"use client";

import { useState } from "react";
import { Shield, Menu, X } from "lucide-react";

const navLinks = [
  { label: "Features", href: "#features" },
  { label: "Pricing", href: "#pricing" },
  { label: "FAQ", href: "#faq" },
];

export default function Navbar() {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <nav
      className="fixed top-0 left-0 right-0 z-50 h-16 backdrop-blur-xl"
      style={{
        backgroundColor: "rgba(6, 6, 11, 0.8)",
        borderBottom: "1px solid rgba(255, 255, 255, 0.06)",
      }}
    >
      <div className="mx-auto flex h-full max-w-6xl items-center justify-between px-6">
        {/* Logo */}
        <a href="#" className="flex items-center gap-2.5">
          <div
            className="flex h-8 w-8 items-center justify-center rounded-lg"
            style={{
              background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
            }}
          >
            <Shield size={22} className="text-white" strokeWidth={2.2} />
          </div>
          <span
            className="font-bold text-white"
            style={{ fontSize: "18px" }}
          >
            Spectra
          </span>
        </a>

        {/* Center nav links - desktop */}
        <div className="hidden items-center gap-8 md:flex">
          {navLinks.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="font-medium transition-colors duration-200"
              style={{
                fontSize: "14px",
                color: "#8b8b9e",
              }}
              onMouseEnter={(e) => {
                (e.target as HTMLElement).style.color = "#f0f0f5";
              }}
              onMouseLeave={(e) => {
                (e.target as HTMLElement).style.color = "#8b8b9e";
              }}
            >
              {link.label}
            </a>
          ))}
        </div>

        {/* Right section */}
        <div className="flex items-center gap-4">
          {/* Get Started button - desktop */}
          <a
            href="/signup"
            className="hidden rounded-lg px-5 py-2 font-medium text-white transition-opacity duration-200 hover:opacity-90 md:inline-flex"
            style={{
              fontSize: "14px",
              background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
            }}
          >
            Get Started
          </a>

          {/* Mobile hamburger */}
          <button
            type="button"
            className="flex h-9 w-9 items-center justify-center rounded-lg transition-colors duration-200 md:hidden"
            style={{ color: "#8b8b9e" }}
            onClick={() => setMobileOpen((prev) => !prev)}
            aria-label="Toggle menu"
          >
            {mobileOpen ? <X size={22} /> : <Menu size={22} />}
          </button>
        </div>
      </div>

      {/* Mobile dropdown */}
      {mobileOpen && (
        <div
          className="border-t px-6 pb-5 pt-4 backdrop-blur-xl md:hidden"
          style={{
            backgroundColor: "rgba(6, 6, 11, 0.95)",
            borderColor: "rgba(255, 255, 255, 0.06)",
          }}
        >
          <div className="flex flex-col gap-4">
            {navLinks.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="font-medium transition-colors duration-200"
                style={{
                  fontSize: "14px",
                  color: "#8b8b9e",
                }}
                onClick={() => setMobileOpen(false)}
                onMouseEnter={(e) => {
                  (e.target as HTMLElement).style.color = "#f0f0f5";
                }}
                onMouseLeave={(e) => {
                  (e.target as HTMLElement).style.color = "#8b8b9e";
                }}
              >
                {link.label}
              </a>
            ))}
            <a
              href="/signup"
              className="mt-1 rounded-lg px-5 py-2.5 text-center font-medium text-white transition-opacity duration-200 hover:opacity-90"
              style={{
                fontSize: "14px",
                background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
              }}
              onClick={() => setMobileOpen(false)}
            >
              Get Started
            </a>
          </div>
        </div>
      )}
    </nav>
  );
}
