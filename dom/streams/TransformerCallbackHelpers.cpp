/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim:set ts=2 sw=2 sts=2 et cindent: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "TransformerCallbackHelpers.h"

#include "mozilla/dom/Promise.h"
#include "mozilla/dom/TransformStreamDefaultController.h"

using namespace mozilla::dom;

NS_IMPL_CYCLE_COLLECTION_WITH_JS_MEMBERS(TransformerAlgorithms,
                                         (mGlobal, mTransformCallback,
                                          mFlushCallback),
                                         (mTransformer))
NS_IMPL_CYCLE_COLLECTION_ROOT_NATIVE(TransformerAlgorithms, AddRef)
NS_IMPL_CYCLE_COLLECTION_UNROOT_NATIVE(TransformerAlgorithms, Release)

// https://streams.spec.whatwg.org/#set-up-transform-stream-default-controller-from-transformer
already_AddRefed<Promise> TransformerAlgorithms::TransformCallback(
    JSContext* aCx, JS::Handle<JS::Value> aChunk,
    TransformStreamDefaultController& aController, ErrorResult& aRv) {
  if (!mTransformCallback) {
    // Step 2.1. Let result be
    // TransformStreamDefaultControllerEnqueue(controller, chunk).
    // TODO

    // Step 2.2. If result is an abrupt completion, return a promise rejected
    // with result.[[Value]].
    // TODO

    // Step 2.3. Otherwise, return a promise resolved with undefined.
    return Promise::CreateResolvedWithUndefined(aController.GetParentObject(),
                                                aRv);
  }
  // Step 4. If transformerDict["transform"] exists, set transformAlgorithm to
  // an algorithm which takes an argument chunk and returns the result of
  // invoking transformerDict["transform"] with argument list « chunk,
  // controller » and callback this value transformer.
  JS::RootedObject thisObj(aCx, mTransformer);
  return MOZ_KnownLive(mTransformCallback)
      ->Call(thisObj, aChunk, aController, aRv,
             "TransformStreamDefaultController.[[transformAlgorithm]]",
             CallbackObject::eRethrowExceptions);
}

// https://streams.spec.whatwg.org/#set-up-transform-stream-default-controller-from-transformer
already_AddRefed<Promise> TransformerAlgorithms::FlushCallback(
    JSContext* aCx, TransformStreamDefaultController& aController,
    ErrorResult& aRv) {
  if (!mFlushCallback) {
    // Step 3. Let flushAlgorithm be an algorithm which returns a promise
    // resolved with undefined.
    return Promise::CreateResolvedWithUndefined(aController.GetParentObject(),
                                                aRv);
  }
  // Step 5. If transformerDict["flush"] exists, set flushAlgorithm to an
  // algorithm which returns the result of invoking transformerDict["flush"]
  // with argument list « controller » and callback this value transformer.
  JS::RootedObject thisObj(aCx, mTransformer);
  return MOZ_KnownLive(mFlushCallback)
      ->Call(thisObj, aController, aRv,
             "TransformStreamDefaultController.[[flushAlgorithm]]",
             CallbackObject::eRethrowExceptions);
}
