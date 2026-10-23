import type { BusinessProfileView } from '@commercebill/shared-types';
import {
  isValidPinCode,
  sellerRegistrationProblems,
  type GstStatus,
} from '@commercebill/setup/browser';
import { ruleText } from '../setup/model.js';

export type ProfileForm = {
  legalName: string;
  tradeName: string;
  businessType: string;
  pan: string;
  gstStatus: GstStatus;
  gstin: string;
  stateCode: string;
  locationName: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  pinCode: string;
};

export type ProfileErrors = Partial<Record<keyof ProfileForm, string>>;

export const formFromProfile = (p: BusinessProfileView): ProfileForm => ({
  legalName: p.legalName,
  tradeName: p.tradeName ?? '',
  businessType: p.businessType ?? '',
  pan: p.pan ?? '',
  gstStatus: p.gstStatus,
  gstin: p.gstin ?? '',
  stateCode: p.stateCode,
  locationName: p.location.name,
  addressLine1: p.location.addressLine1,
  addressLine2: p.location.addressLine2 ?? '',
  city: p.location.city ?? '',
  pinCode: p.location.pinCode ?? '',
});

const orNull = (s: string) => (s.trim() === '' ? null : s.trim());

/** The request body. The server re-validates everything; the organization comes from the session, never from here. */
export const requestFromForm = (f: ProfileForm, version: number) => ({
  legalName: f.legalName.trim(),
  tradeName: orNull(f.tradeName),
  businessType: orNull(f.businessType),
  pan: orNull(f.pan)?.toUpperCase() ?? null,
  gstStatus: f.gstStatus,
  gstin: f.gstStatus === 'UNREGISTERED' ? null : (orNull(f.gstin)?.toUpperCase() ?? null),
  stateCode: f.stateCode,
  location: {
    name: f.locationName.trim(),
    addressLine1: f.addressLine1.trim(),
    addressLine2: orNull(f.addressLine2),
    city: orNull(f.city),
    pinCode: orNull(f.pinCode),
  },
  expectedVersion: version,
});

const LOCAL_TEXT: Record<string, string> = {
  duplicate: 'Another location already uses this name.',
  too_long: 'This is too long.',
};

const FIELD_KEY: Record<string, keyof ProfileForm> = {
  legalName: 'legalName',
  tradeName: 'tradeName',
  businessType: 'businessType',
  pan: 'pan',
  gstStatus: 'gstStatus',
  gstin: 'gstin',
  stateCode: 'stateCode',
  'location.name': 'locationName',
  'location.addressLine1': 'addressLine1',
  'location.addressLine2': 'addressLine2',
  'location.city': 'city',
  'location.pinCode': 'pinCode',
};

/** Early feedback with the SAME rules as the server (the shared seller rules); the server stays authoritative. */
export function validateForm(f: ProfileForm): ProfileErrors {
  const e: ProfileErrors = {};
  const set = (field: keyof ProfileForm, rule: string) => {
    e[field] ??= LOCAL_TEXT[rule] ?? ruleText('', rule);
  };
  if (!f.legalName.trim()) set('legalName', 'required');
  if (!f.locationName.trim()) set('locationName', 'required');
  if (!f.addressLine1.trim()) set('addressLine1', 'required');
  if (f.pinCode.trim() && !isValidPinCode(f.pinCode.trim())) set('pinCode', 'invalid_pin_code');
  const gstin = f.gstStatus === 'UNREGISTERED' ? null : (orNull(f.gstin)?.toUpperCase() ?? null);
  for (const p of sellerRegistrationProblems({
    gstStatus: f.gstStatus,
    gstin,
    pan: orNull(f.pan)?.toUpperCase() ?? null,
    stateCode: f.stateCode,
  }))
    set(FIELD_KEY[p.field] ?? 'gstin', p.rule);
  return e;
}

/** Field errors from the server's value-free problem list. */
export function errorsFromProblems(problems: { field: string; rule: string }[]): ProfileErrors {
  const e: ProfileErrors = {};
  for (const p of problems) {
    const key = FIELD_KEY[p.field];
    if (key) e[key] ??= LOCAL_TEXT[p.rule] ?? ruleText('', p.rule);
  }
  return e;
}

/** Plain names for the fields reported as changed. */
export const FIELD_LABEL: Record<string, string> = {
  legalName: 'Legal business name',
  tradeName: 'Trade name',
  businessType: 'Business type',
  pan: 'PAN',
  gstStatus: 'GST registration status',
  gstin: 'GSTIN',
  stateCode: 'State',
  'location.name': 'Location name',
  'location.addressLine1': 'Address line 1',
  'location.addressLine2': 'Address line 2',
  'location.city': 'City',
  'location.pinCode': 'PIN code',
};

/** Facts the profile does not store yet (listed, never silently dropped). */
export const NOT_STORED_YET = ['Phone number', 'Email address', 'Website', 'Bank details', 'Logo'];
