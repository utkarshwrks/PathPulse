export {
  ML_CHANNELS,
  ML_SAMPLE_RATE_HZ,
  ML_WINDOW_SAMPLES,
  MockSpeedPredictor,
  NullSpeedPredictor,
  SpeedSmoother,
  SpeedWindowBuffer,
  type SpeedPredictor,
} from './speedModel.js';
export {
  CnnSpeedPredictor,
  decodeFloat32,
  parseSpeedCnnWeights,
  runSpeedCnn,
  type SpeedCnnLayer,
  type SpeedCnnWeights,
} from './cnn.js';
