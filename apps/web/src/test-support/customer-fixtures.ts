// Test-only: customer records for component tests (fictional data). Not shipped.
import type { CustomerView } from '@commercebill/shared-types';

let n = 0;

export function customer(over: Partial<CustomerView> = {}): CustomerView {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    code: `CUS-${String(n).padStart(6, '0')}`,
    customerType: 'B2C',
    legalName: `Fictional Customer ${n}`,
    displayName: null,
    contactPerson: null,
    email: null,
    phone: null,
    alternatePhone: null,
    gstStatus: 'UNREGISTERED',
    gstin: null,
    pan: null,
    billingAddressLine1: '1 Test Lane',
    billingAddressLine2: null,
    billingCity: 'Mumbai',
    billingStateCode: '27',
    billingStateName: 'Maharashtra',
    billingPinCode: null,
    country: 'IN',
    shippingSameAsBilling: true,
    shippingAddressLine1: null,
    shippingAddressLine2: null,
    shippingCity: null,
    shippingStateCode: null,
    shippingStateName: null,
    shippingPinCode: null,
    placeOfSupplyStateCode: '27',
    placeOfSupplyStateName: 'Maharashtra',
    creditLimit: null,
    paymentTermsDays: null,
    notes: null,
    isActive: true,
    createdAt: '2026-10-19T00:00:00.000Z',
    updatedAt: '2026-10-19T00:00:00.000Z',
    version: 1,
    ...over,
  };
}
