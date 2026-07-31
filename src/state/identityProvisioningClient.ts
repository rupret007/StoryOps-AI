import {
  buildIdentityProvisioningCommand,
  identityProvisioningReceiptSchema,
  identityProvisioningStateSchema,
  type IdentityProvisioningInput,
  type IdentityProvisioningReceipt,
  type IdentityProvisioningState,
} from '@/core/identity/provisioning';

type IdentityClientError = Readonly<{
  message: string;
  code?: string;
  status?: number;
}>;

export interface IdentityProvisioningEdgeClient {
  functions: {
    invoke(
      functionName: string,
      input: { body: Record<string, unknown> },
    ): Promise<{ data: unknown; error: IdentityClientError | null }>;
  };
}

export class IdentityProvisioningClientError extends Error {
  readonly name = 'IdentityProvisioningClientError';

  constructor(
    readonly code: string | undefined,
    readonly status: number | undefined,
    message: string,
  ) {
    super(message);
  }
}

function edgeError(error: IdentityClientError): IdentityProvisioningClientError {
  return new IdentityProvisioningClientError(error.code, error.status, error.message);
}

export class TrustedIdentityProvisioningClient {
  constructor(
    private readonly client: IdentityProvisioningEdgeClient,
    readonly companyId: string,
  ) {}

  async loadState(): Promise<IdentityProvisioningState> {
    const { data, error } = await this.client.functions.invoke('identity-provisioning', {
      body: {
        operation: 'state',
        companyId: this.companyId,
      },
    });
    if (error) throw edgeError(error);
    const state = identityProvisioningStateSchema.parse(data);
    if (state.companyId !== this.companyId || state.externalDeliveryClaimed) {
      throw new Error('Identity state escaped the exact authenticated company scope.');
    }
    return state;
  }

  async execute(input: IdentityProvisioningInput): Promise<IdentityProvisioningReceipt> {
    const command = await buildIdentityProvisioningCommand({
      companyId: this.companyId,
      command: input,
    });
    const { data, error } = await this.client.functions.invoke('identity-provisioning', {
      body: command,
    });
    if (error) throw edgeError(error);
    const receipt = identityProvisioningReceiptSchema.parse(data);
    if (
      receipt.companyId !== this.companyId ||
      receipt.commandId !== command.request.commandId ||
      receipt.requestHash !== command.requestHash ||
      receipt.action !== command.request.action ||
      receipt.email !== command.request.email ||
      receipt.role !== command.request.role ||
      receipt.customerId !== command.request.customerId ||
      receipt.externalDeliveryClaimed
    ) {
      throw new Error('Identity receipt did not match the complete submitted request.');
    }
    return receipt;
  }
}
