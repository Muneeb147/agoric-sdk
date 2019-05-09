import { parseJSON } from './helpers';

// TODO: implement verify
function verify(_senderID) {
  return true;
}

export function makeSendIn(state, syscall) {
  return {
    /**
     * aka 'inbound' from SwingSet-Cosmos
     * @param  {string} senderID public key?
     * @param  {string} dataStr JSON, such as:
     * {
     *  index: 0,
     *  methodName: 'getIssuer',
     *  args: [],
     *  resultIndex: 1,
     * }
     *
     */

    sendIn(senderID, dataStr) {
      if (!verify(senderID)) {
        throw new Error('could not verify SenderID');
      }

      const data = parseJSON(dataStr);

      // everything that comes in to us as a target or a slot needs to
      // get mapped to a kernel slot. If we don't already have a kernel slot for
      // something, we should allocate it.

      function mapInbound(youToMeSlot) {
        let kernelToMeSlot = state.clists.mapIncomingWireMessageToKernelSlot(
          senderID,
          youToMeSlot,
        );
        if (kernelToMeSlot === undefined) {
          // we are telling the kernel about something that exists on
          // another machine, these are ingresses

          switch (youToMeSlot.type) {
            case 'your-ingress': {
              const exportID = state.ids.allocateID();
              kernelToMeSlot = { type: 'export', id: exportID };
              break;
            }
            case 'your-answer': {
              // our "answer" is a resolver, we can find out the
              // answer and notify the other machine.
              // "answers" are active, "questions" are passive

              // your answer because other machine generated the
              // youToMeSlot id

              // we need a way to store the resolver, and resolver or
              // reject it when we get a notification to do so from
              // the other side.
              const pr = syscall.createPromise();

              // add resolver
              const resolverKernelToMeSlot = {
                type: 'resolver',
                id: pr.resolverID,
              };

              kernelToMeSlot = { type: 'promise', id: pr.promiseID };

              syscall.subscribe(pr.promiseID);

              state.resolvers.add(kernelToMeSlot, resolverKernelToMeSlot);
              break;
            }
            case 'your-question': {

              throw new Error('we should not be using questions as ');
              break;
            }
            default:
              throw new Error(
                `youToMeSlot.type ${youToMeSlot.type} is unexpected`,
              );
          }

          state.clists.add(
            senderID,
            kernelToMeSlot,
            youToMeSlot,
            state.clists.changePerspective(youToMeSlot),
          );
        }
        return state.clists.mapIncomingWireMessageToKernelSlot(
          senderID,
          youToMeSlot,
        );
      }

      // if not an event, then we are going to be calling something on
      // an object that we know about (is this right?)

      // get the target (an object representing a promise or a vat
      // object) from the index in the data

      let kernelToMeSlots;
      let kernelToMeTarget;
      if (data.slots) {
        // Object {type: "your-answer", id: 2}
        kernelToMeSlots = data.slots.map(mapInbound);
      }
      if (data.target) {
        kernelToMeTarget = state.clists.mapIncomingWireMessageToKernelSlot(
          senderID,
          data.target,
        );
      }

      if (data.event) {
        const resolverKernelToMeSlot = mapInbound(data.promise);
        switch (data.event) {
          case 'notifyFulfillToData':
            syscall.fulfillToData(
              resolverKernelToMeSlot.id,
              data.args,
              kernelToMeSlots,
            );
            return;
          case 'notifyFulfillToTarget':
            syscall.fulfillToTarget(
              resolverKernelToMeSlot.id,
              kernelToMeTarget,
            );
            return;
          case 'notifyReject':
            syscall.notifyReject(
              resolverKernelToMeSlot.id,
              data.args,
              kernelToMeSlots,
            );
            return;
          default:
            throw new Error(`unknown event ${data.event}`);
        }
      }

      /* slots are used when referencing a
        presence as an arg, e.g.:
        {
          index: 2,
          methodName: 'deposit',
          args: [20, { '@qclass': 'slot', index: 0 }],
          slots: [{ type: 'export', index: 0 }],
          resultIndex: 3,
        }
      */

      // put the target.methodName(args, slots) call on the runQueue to
      // be delivered
      const promiseID = syscall.send(
        kernelToMeTarget,
        data.methodName,
        JSON.stringify({ args: data.args }),
        kernelToMeSlots,
      );

      // if there is a resultIndex passed in, the inbound sender wants
      // to know about the result, so we need to store this in clist for
      // the sender to have future access to

      if (data.answerSlot) {
        const kernelToMeSlot = {
          type: 'promise',
          id: promiseID,
        };
        const youToMeSlot = data.answerSlot; // your-answer = our answer, their question
        const meToYouSlot = state.clists.changePerspective(youToMeSlot);
        state.clists.add(senderID, kernelToMeSlot, youToMeSlot, meToYouSlot);
        syscall.subscribe(promiseID);
      }
    },
  };
}
