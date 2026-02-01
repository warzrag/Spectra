import React from 'react';
import { CreditCard, Check, Zap, Shield, Users } from 'lucide-react';

const plans = [
  {
    name: 'Free',
    price: '$0',
    period: '/month',
    features: ['2 browser profiles', '1 team member', 'Basic fingerprinting', 'Community support'],
    current: true,
    color: 'var(--text-muted)',
  },
  {
    name: 'Pro',
    price: '$29',
    period: '/month',
    features: ['100 browser profiles', '5 team members', 'Advanced fingerprinting', 'Priority support', 'Cookie import/export', 'API access'],
    current: false,
    color: 'var(--accent)',
  },
  {
    name: 'Enterprise',
    price: '$99',
    period: '/month',
    features: ['Unlimited profiles', 'Unlimited members', 'Premium fingerprinting', 'Dedicated support', 'Custom automation', 'White-label option'],
    current: false,
    color: '#f59e0b',
  },
];

const BillingPage: React.FC = () => {
  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto p-6 space-y-8">
        {/* Header */}
        <div>
          <h1 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>Billing</h1>
          <p className="text-[13px] mt-1" style={{ color: 'var(--text-muted)' }}>Manage your subscription and plan</p>
        </div>

        {/* Current Plan */}
        <section>
          <h2 className="text-[14px] font-semibold mb-4 flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <CreditCard size={16} style={{ color: 'var(--accent)' }} />
            Current Plan
          </h2>
          <div className="rounded-xl p-5" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)' }}>
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>Free Plan</span>
                  <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold uppercase" style={{ background: 'var(--accent-subtle)', color: 'var(--accent-light)' }}>Active</span>
                </div>
                <p className="text-[13px] mt-1" style={{ color: 'var(--text-muted)' }}>Basic access with limited profiles</p>
              </div>
              <div className="text-right">
                <div className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>$0</div>
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>per month</div>
              </div>
            </div>

            {/* Usage */}
            <div className="mt-5 grid grid-cols-2 gap-4">
              <div className="rounded-lg p-3" style={{ background: 'var(--bg-elevated)' }}>
                <div className="flex items-center gap-2 mb-1">
                  <Shield size={14} style={{ color: 'var(--accent)' }} />
                  <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>Profiles</span>
                </div>
                <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                  <span style={{ color: 'var(--accent-light)' }}>--</span> / 2
                </div>
                <div className="mt-2 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--border-default)' }}>
                  <div className="h-full rounded-full" style={{ width: '50%', background: 'var(--accent)' }} />
                </div>
              </div>
              <div className="rounded-lg p-3" style={{ background: 'var(--bg-elevated)' }}>
                <div className="flex items-center gap-2 mb-1">
                  <Users size={14} style={{ color: 'var(--success)' }} />
                  <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>Team Members</span>
                </div>
                <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                  <span style={{ color: 'var(--success)' }}>1</span> / 1
                </div>
                <div className="mt-2 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--border-default)' }}>
                  <div className="h-full rounded-full" style={{ width: '100%', background: 'var(--success)' }} />
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Plans */}
        <section>
          <h2 className="text-[14px] font-semibold mb-4 flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <Zap size={16} style={{ color: '#f59e0b' }} />
            Available Plans
          </h2>
          <div className="grid grid-cols-3 gap-4">
            {plans.map((plan) => (
              <div
                key={plan.name}
                className="rounded-xl p-5 relative"
                style={{
                  background: 'var(--bg-surface)',
                  border: plan.current ? `2px solid var(--accent)` : '1px solid var(--border-default)',
                }}
              >
                {plan.current && (
                  <div className="absolute -top-2.5 left-1/2 -translate-x-1/2">
                    <span className="text-[10px] px-3 py-0.5 rounded-full font-semibold" style={{ background: 'var(--accent)', color: 'white' }}>
                      Current
                    </span>
                  </div>
                )}
                <div className="text-center mb-4 mt-1">
                  <h3 className="text-[15px] font-bold" style={{ color: 'var(--text-primary)' }}>{plan.name}</h3>
                  <div className="mt-2">
                    <span className="text-2xl font-bold" style={{ color: plan.color }}>{plan.price}</span>
                    <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>{plan.period}</span>
                  </div>
                </div>
                <ul className="space-y-2 mb-5">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                      <Check size={14} style={{ color: plan.current ? 'var(--accent)' : 'var(--text-muted)' }} />
                      {feature}
                    </li>
                  ))}
                </ul>
                <button
                  className="w-full py-2 rounded-lg text-[13px] font-medium transition-all"
                  style={plan.current ? {
                    background: 'var(--bg-elevated)',
                    color: 'var(--text-muted)',
                    cursor: 'default',
                  } : {
                    background: plan.name === 'Enterprise' ? 'linear-gradient(135deg, #f59e0b, #d97706)' : 'linear-gradient(135deg, #6366f1, #7c3aed)',
                    color: 'white',
                    cursor: 'pointer',
                  }}
                  disabled={plan.current}
                >
                  {plan.current ? 'Current Plan' : 'Upgrade'}
                </button>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
};

export default BillingPage;
