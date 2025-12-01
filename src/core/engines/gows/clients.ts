import * as grpc from '@grpc/grpc-js';
import { messages } from '@waha/core/engines/gows/grpc/gows';

let messageServiceClient: messages.MessageServiceClient | null = null;
let eventStreamClient: messages.EventStreamClient | null = null;

export const MessageServiceClientSingleton = (
  address: string,
  credentials: grpc.ChannelCredentials,
): messages.MessageServiceClient => {
  if (!messageServiceClient) {
    messageServiceClient = new messages.MessageServiceClient(
      address,
      credentials,
      {
        'grpc.max_send_message_length': 128 * 1024 * 1024,
        'grpc.max_receive_message_length': 128 * 1024 * 1024,
      },
    );
  }
  return messageServiceClient;
};

export const EventStreamClientSingleton = (
  address: string,
  credentials: grpc.ChannelCredentials,
): messages.EventStreamClient => {
  if (!eventStreamClient) {
    eventStreamClient = new messages.EventStreamClient(address, credentials, {
      'grpc.max_send_message_length': 128 * 1024 * 1024,
      'grpc.max_receive_message_length': 128 * 1024 * 1024,
    });
  }
  return eventStreamClient;
};
