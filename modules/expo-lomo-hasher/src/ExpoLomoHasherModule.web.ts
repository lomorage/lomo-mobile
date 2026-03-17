import { registerWebModule, NativeModule } from 'expo';

import { ChangeEventPayload } from './ExpoLomoHasher.types';

type ExpoLomoHasherModuleEvents = {
  onChange: (params: ChangeEventPayload) => void;
}

class ExpoLomoHasherModule extends NativeModule<ExpoLomoHasherModuleEvents> {
  PI = Math.PI;
  async setValueAsync(value: string): Promise<void> {
    this.emit('onChange', { value });
  }
  hello() {
    return 'Hello world! 👋';
  }
};

export default registerWebModule(ExpoLomoHasherModule, 'ExpoLomoHasherModule');
