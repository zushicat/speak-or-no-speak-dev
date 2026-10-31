# Revision 5
Let's say I commit this project to my repo and make it public so that a user could simply link or download the minified code.
This is just a sketch but something of this sorts:
```
<script src="https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.wasm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.31/dist/bundle.min.js"></script>
<script src="https://my github link to/build/speak-or-no-speak.esm.js"></script> <----- something like this
<script type="module">
  import { createSpeakOrNoSpeak } from "./speak-or-no-speak.esm.js"; <----- instead of this

  import { createSpeakOrNoSpeak } <---- would this then work?

  // API from here on
</script>
```
This is some modified snippet taken from [docs/04-embedding.md](/Users/karin/_programming/speak-or-no-speak/docs/04-embedding.md)

I do not want to commit anything to https://cdn.jsdelivr.net/npm

When i look at
- https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.wasm.min.js
- https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.31/dist/bundle.min.js
these seem to be kind of minified stand alone versions.

Especially when looking at ort.wasm.min.js I see
```
/*!
 * ONNX Runtime Web v1.22.0
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */
```
Isn't this something I use as well?

When I look at the files in directory [build](/Users/karin/_programming/speak-or-no-speak/build) there are all kinds of files. I do not know what they are for.
Can I simply rename speak-or-no-speak.esm.js to speak-or-no-speak.min.js ?

## Your task
Explain the differences and what to do to simply get a minified version that a user can simply download or link.
Store it in [explain-rev-5.md](/Users/karin/_programming/speak-or-no-speak/plans/rev-5/explain-rev-5.md)