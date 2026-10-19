// Test-only helpers that drive the setup wizard the way a person would (labels, buttons), shared by the component
// tests and the real-API tests. Not shipped.
import { fireEvent, screen } from '@testing-library/react';
import { gstinCheckCharacter } from '../../../../packages/setup/src/validators.js';

const first14 = '27ABCDE1234F1Z';

/** Fictional values only. The GSTIN is built with the published check-character algorithm so it passes the checksum. */
export const SAMPLE = {
  legalName: 'Sample Traders Private Limited',
  tradeName: 'Sample Traders',
  businessType: 'Private limited company',
  pan: 'ABCDE1234F',
  addressLine1: '12 Example Road',
  addressLine2: 'Test Nagar',
  city: 'Mumbai',
  stateCode: '27',
  pinCode: '400001',
  gstin: `${first14}${gstinCheckCharacter(first14)}`,
  fyStart: '2026-04-01',
  admin: {
    displayName: 'Priya Nair',
    username: 'priya.admin',
    email: 'priya@example.test',
    password: 'Velvet anchor orbit 7731',
  },
} as const;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Finds a field by its label, ignoring the trailing "(required)" / "(optional)". */
export function field(label: string): HTMLElement {
  return screen.getByLabelText(new RegExp(`^${escape(label)}( \\((required|optional)\\))?$`));
}

export function type(label: string, value: string): void {
  fireEvent.change(field(label), { target: { value } });
}

export function click(name: string | RegExp): void {
  fireEvent.click(screen.getByRole('button', { name }));
}

export async function onStep(heading: string): Promise<void> {
  await screen.findByRole('heading', { name: heading });
}

export async function fillBusiness(): Promise<void> {
  await onStep('Business details');
  type('Legal business name', SAMPLE.legalName);
  type('Trade / display name', SAMPLE.tradeName);
  type('Business type', SAMPLE.businessType);
  type('PAN', SAMPLE.pan);
}

export async function fillAddress(): Promise<void> {
  await onStep('Address & location');
  type('Address line 1', SAMPLE.addressLine1);
  type('Address line 2', SAMPLE.addressLine2);
  type('City', SAMPLE.city);
  type('PIN code', SAMPLE.pinCode);
  type('State / union territory', SAMPLE.stateCode);
}

export async function fillGst(): Promise<void> {
  await onStep('GST registration');
  fireEvent.click(screen.getByRole('radio', { name: /^Registered/ }));
  type('GSTIN', SAMPLE.gstin);
}

export async function fillAdmin(password: string = SAMPLE.admin.password): Promise<void> {
  await onStep('Administrator');
  type('Administrator name', SAMPLE.admin.displayName);
  type('Username', SAMPLE.admin.username);
  type('Email', SAMPLE.admin.email);
  type('Password', password);
  type('Confirm password', password);
}

/** From the Welcome screen to the Review screen with every step filled in (Continue pressed on each). */
export async function walkToReview(password: string = SAMPLE.admin.password): Promise<void> {
  await screen.findByRole('heading', { name: 'CommerceBill setup' });
  click('Start Setup');
  await fillBusiness();
  click('Continue');
  await fillAddress();
  click('Continue');
  await fillGst();
  click('Continue');
  await onStep('Financial year');
  click('Continue');
  await onStep('Invoice numbering');
  click('Continue');
  await fillAdmin(password);
  click('Continue');
  await onStep('Review & complete');
}
