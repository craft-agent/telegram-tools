import { BYTES_PER_MB } from "../telegram/service-requests"

/** The most files one send carries: what the messaging service takes in one message. */
export const MAX_FILES = 10

/** The most bytes one send carries, all its files together: what the messaging service takes in one message, 100 MB. */
export const MAX_TOTAL_BYTES = 100 * BYTES_PER_MB
