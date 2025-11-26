import * as grpc from '@grpc/grpc-js';
import { messages } from '@waha/core/engines/gows/grpc/gows';

let messageServiceClient: messages.MessageServiceClient | null = null;
let eventStreamClient: messages.EventStreamClient | null = null;

export const MessageServiceClientSingleton = (
  address: string,
  credentials: grpc.ChannelCredentials,
  options?: grpc.ChannelOptions,
): messages.MessageServiceClient => {
  if (!messageServiceClient) {
    messageServiceClient = new messages.MessageServiceClient(
      address,
      credentials,
      options,
    );
  }
  return messageServiceClient;
};

export const EventStreamClientSingleton = (
  address: string,
  credentials: grpc.ChannelCredentials,
  options?: grpc.ChannelOptions,
): messages.EventStreamClient => {
  if (!eventStreamClient) {
    eventStreamClient = new messages.EventStreamClient(
      address,
      credentials,
      options,
    );
  }
  return eventStreamClient;
};
